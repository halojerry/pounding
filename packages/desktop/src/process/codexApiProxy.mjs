#!/usr/bin/env node
/**
 * Codex Responses API → Chat Completions API local proxy.
 *
 * Codex CLI requires `wire_api = "responses"` (OpenAI Responses API format),
 * but the POUNDING API only supports the Chat Completions API for the
 * `deepseek-v4-pro` model. This proxy translates between the two formats,
 * including SSE streaming support.
 *
 * Usage: node codex-api-proxy.mjs --port 18792 --upstream https://api.mxou.cn/v1
 */

import http from 'node:http';

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const PORT = parseInt(getArg('--port') || '18792', 10);
const UPSTREAM = (getArg('--upstream') || 'https://api.mxou.cn/v1').replace(/\/+$/, '');

// Read API key from ~/.pounding/config.json as a last-resort fallback.
// The parent process (CodexProxyManager) passes POUNDING_API_KEY via env,
// but on first startup before login the file may not exist yet. When the
// proxy is restarted post-login, this ensures it can still find the key
// even if the env var wasn't set for any reason.
function readApiKeyFromDisk() {
  try {
    const { join } = require('path');
    const { homedir } = require('os');
    const { existsSync, readFileSync } = require('fs');
    const configPath = join(homedir(), '.pounding', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return (config.api && config.api.key) || '';
    }
  } catch {
    /* best-effort — env var and --api-key are the primary sources */
  }
  return '';
}
const API_KEY = getArg('--api-key') || process.env.POUNDING_API_KEY || readApiKeyFromDisk();

// ── Translation: Responses API → Chat Completions ──────────────────────────

function responsesToChatCompletions(body) {
  const input = body.input;
  let messages = [];

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item.role) {
        // Map 'developer' role to 'system' (POUNDING API compatibility)
        const role = item.role === 'developer' ? 'system' : item.role;

        if (Array.isArray(item.content)) {
          // Separate text from tool_use parts
          const textParts = [];
          const toolCalls = [];
          for (const part of item.content) {
            if (part.type === 'tool_use') {
              // Responses API: {type:"tool_use", id, name, input}
              // → Chat Completions: {id, type:"function", function:{name, arguments}}
              toolCalls.push({
                id: part.id,
                type: 'function',
                function: {
                  name: part.name,
                  arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {}),
                },
              });
            } else if (part.type === 'input_text') {
              textParts.push(part.text || '');
            } else if (part.type === 'text') {
              textParts.push(part.text || '');
            } else if (part.type === 'output_text') {
              // Replayed assistant output in history — treat as text
              textParts.push(part.text || '');
            }
          }

          const msg = { role };
          if (textParts.length > 0) {
            msg.content = textParts.join('');
          }
          if (toolCalls.length > 0) {
            msg.tool_calls = toolCalls;
          }
          // If neither text nor tool_calls, still include the message with empty content
          if (!msg.content && !msg.tool_calls) {
            msg.content = '';
          }
          messages.push(msg);
        } else {
          // Non-array content (plain string)
          messages.push({ role, content: item.content ?? '' });
        }
      } else if (item.content) {
        messages.push({ role: 'user', content: item.content });
      }
    }
  }

  // Second pass: translate tool-role messages (Responses API → Chat Completions)
  // Responses API: {role:"tool", content:[{type:"tool_result", tool_use_id, content}]}
  // Chat Completions: {role:"tool", tool_call_id, content: string}
  messages = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    if (!Array.isArray(msg.content)) return msg;

    const toolResults = [];
    for (const part of msg.content) {
      if (part.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: part.tool_use_id || part.tool_call_id,
          content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content || ''),
        });
      }
    }
    // A single tool message in Responses API may contain multiple tool_results;
    // Chat Completions expects one message per tool result. Return the first
    // one as-is (replacing the original message) and we'll handle multiples
    // by flattening below.
    if (toolResults.length === 1) return toolResults[0];
    if (toolResults.length > 1) {
      // Replace with first, return others via a marker
      toolResults[0].__extraToolMessages = toolResults.slice(1);
      return toolResults[0];
    }
    return msg;
  });

  // Flatten any extra tool messages
  const flattened = [];
  for (const msg of messages) {
    flattened.push(msg);
    if (msg.__extraToolMessages) {
      flattened.push(...msg.__extraToolMessages);
      delete msg.__extraToolMessages;
    }
  }

  const req = {
    model: body.model,
    messages: flattened,
  };

  if (body.max_output_tokens) req.max_tokens = body.max_output_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.instructions) {
    req.messages.unshift({ role: 'system', content: body.instructions });
  }
  if (body.stop) req.stop = body.stop;
  // Always non-streaming for REST; streaming handled separately via SSE
  req.stream = false;

  return req;
}

function chatCompletionToResponse(ccResp, model) {
  const choice = ccResp.choices?.[0] ?? {};
  const message = choice.message ?? {};

  const output = [];
  if (message.content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content }],
    });
  }
  // Translate tool_calls → function_call outputs
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        id: tc.id,
        type: 'function_call',
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
        status: 'completed',
      });
    }
  }
  if (message.reasoning_content) {
    output.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    });
  }

  return {
    id: ccResp.id?.replace('chatcmpl-', 'resp_') ?? 'resp_proxy',
    object: 'response',
    created_at: ccResp.created,
    model: ccResp.model ?? model,
    output,
    status: 'completed',
    usage: ccResp.usage
      ? {
          input_tokens: ccResp.usage.prompt_tokens ?? 0,
          output_tokens: ccResp.usage.completion_tokens ?? 0,
          total_tokens: ccResp.usage.total_tokens ?? 0,
          input_tokens_details: { cached_tokens: ccResp.usage.prompt_tokens_details?.cached_tokens ?? 0 },
          output_tokens_details: { reasoning_tokens: ccResp.usage.completion_tokens_details?.reasoning_tokens ?? 0 },
        }
      : undefined,
  };
}

// ── HTTP Proxy ─────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    // ── /v1/models ────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/v1/models') {
      const upstreamResp = await fetch(`${UPSTREAM}/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const data = await upstreamResp.json();

      // Enrich model metadata so Codex doesn't show "Model metadata for
      // X not found. Defaulting to fallback metadata" warnings.
      // The POUNDING API only returns {id, object, created, owned_by}
      // but Codex expects context_window, max_output_tokens, etc.
      const METADATA = {
        'deepseek-v4-pro': { context_window: 256000, max_output_tokens: 32000, pricing: { prompt: 0, completion: 0 } },
        'deepseek-v4-flash': {
          context_window: 256000,
          max_output_tokens: 32000,
          pricing: { prompt: 0, completion: 0 },
        },
        'mimo-v2.5': { context_window: 256000, max_output_tokens: 16384, pricing: { prompt: 0, completion: 0 } },
        'mimo-v2.5-pro': { context_window: 256000, max_output_tokens: 16384, pricing: { prompt: 0, completion: 0 } },
        'MiniMax-M2.7-highspeed': {
          context_window: 256000,
          max_output_tokens: 16384,
          pricing: { prompt: 0, completion: 0 },
        },
        'doubao-seed-1-8-251228': {
          context_window: 128000,
          max_output_tokens: 16384,
          pricing: { prompt: 0, completion: 0 },
        },
        'agnes-2.0-flash': { context_window: 128000, max_output_tokens: 16384, pricing: { prompt: 0, completion: 0 } },
      };

      if (Array.isArray(data.data)) {
        data.data = data.data.map((m) => {
          const meta = METADATA[m.id];
          if (meta) {
            return { ...m, ...meta };
          }
          // For unknown models, provide reasonable defaults
          return { ...m, context_window: 256000, max_output_tokens: 16384 };
        });
      }

      res.writeHead(upstreamResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // ── /v1/responses ─────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/v1/responses') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const responsesReq = JSON.parse(body);
      const isStream = responsesReq.stream !== false;

      console.log(
        `[proxy] ${responsesReq.model}: stream=${isStream} ${JSON.stringify(responsesReq.input).slice(0, 100)}...`
      );

      if (!isStream) {
        // ── Non-streaming (simple JSON) ──────────────────────────────
        const chatReq = responsesToChatCompletions(responsesReq);
        const upstreamResp = await fetch(`${UPSTREAM}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(chatReq),
        });

        const ccResp = await upstreamResp.json();

        if (!upstreamResp.ok) {
          console.error(`[proxy] upstream error:`, JSON.stringify(ccResp).slice(0, 200));
          // Wrap Chat Completions error in Responses API format so Codex can parse it
          const msg = ccResp?.error?.message ?? ccResp?.error?.code ?? `HTTP ${upstreamResp.status}`;
          res.writeHead(upstreamResp.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'upstream_error', message: msg } }));
          return;
        }

        const responsesResp = chatCompletionToResponse(ccResp, responsesReq.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responsesResp));
        console.log(`[proxy] OK: ${responsesResp.output?.[0]?.content?.[0]?.text?.slice(0, 80) ?? '(no text)'}`);
        return;
      }

      // ── Streaming (Server-Sent Events) ─────────────────────────────
      const chatReq = responsesToChatCompletions(responsesReq);
      chatReq.stream = true;
      chatReq.stream_options = { include_usage: true };

      const upstreamResp = await fetch(`${UPSTREAM}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(chatReq),
      });

      if (!upstreamResp.ok) {
        const errText = await upstreamResp.text();
        console.error(`[proxy] upstream stream error:`, errText.slice(0, 200));
        // Wrap in Responses API error format
        let msg = `HTTP ${upstreamResp.status}`;
        try {
          const errJson = JSON.parse(errText);
          msg = errJson?.error?.message ?? errJson?.error?.code ?? msg;
        } catch {}
        res.writeHead(upstreamResp.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'upstream_error', message: msg } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const responseId = 'resp_' + Date.now();
      const msgItemId = 'msg_' + Date.now();
      res.write(
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: {
            id: responseId,
            object: 'response',
            model: responsesReq.model,
            status: 'in_progress',
            output: [],
          },
        })}\n\n`
      );

      // Send output_item.added BEFORE any deltas — Codex requires this
      // to create an active item that output_text.delta events can target.
      res.write(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: msgItemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        })}\n\n`
      );

      res.write(
        `event: response.content_part.added\ndata: ${JSON.stringify({
          type: 'response.content_part.added',
          item_id: msgItemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        })}\n\n`
      );

      // Read SSE stream from upstream
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';
      let usageInfo = null;
      // Track tool calls by index for streaming translation:
      // Chat Completions SSE → Responses API function_call events
      const toolCallsByIndex = {};
      let nextOutputIndex = 1; // 0 = the text message item

      try {
        // SSE stream read — await-in-loop is the standard pattern for async iteration
        while (true) {
          // oxlint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                fullContent += delta.content;
                res.write(
                  `event: response.output_text.delta\ndata: ${JSON.stringify({
                    type: 'response.output_text.delta',
                    item_id: msgItemId,
                    output_index: 0,
                    content_index: 0,
                    delta: delta.content,
                  })}\n\n`
                );
              }
              // Handle tool_calls in streaming delta
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  let entry = toolCallsByIndex[idx];
                  // New tool call — first chunk carries id + function.name
                  if (tc.id) {
                    entry = {
                      id: tc.id,
                      name: tc.function?.name || '',
                      arguments: '',
                      outputIndex: nextOutputIndex++,
                    };
                    toolCallsByIndex[idx] = entry;
                    // Emit output_item.added for this function_call
                    res.write(
                      `event: response.output_item.added\ndata: ${JSON.stringify({
                        type: 'response.output_item.added',
                        output_index: entry.outputIndex,
                        item: {
                          id: entry.id,
                          type: 'function_call',
                          name: entry.name,
                          arguments: '',
                          status: 'in_progress',
                        },
                      })}\n\n`
                    );
                  }
                  if (!entry) continue;
                  // Accumulate arguments
                  if (tc.function?.arguments) {
                    entry.arguments += tc.function.arguments;
                    // Also update name if provided in follow-up chunks
                    if (tc.function?.name) entry.name = tc.function.name;
                    res.write(
                      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
                        type: 'response.function_call_arguments.delta',
                        item_id: entry.id,
                        output_index: entry.outputIndex,
                        delta: tc.function.arguments,
                      })}\n\n`
                    );
                  }
                }
              }
              if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;
              if (chunk.usage) usageInfo = chunk.usage;
            } catch {
              /* skip malformed JSON in SSE stream */
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Emit terminal events for tool calls BEFORE the text message events.
      // Responses API spec: function_call_arguments.done → output_item.done
      // for each function_call, in output_index order.
      const toolCallEntries = Object.values(toolCallsByIndex).toSorted((a, b) => a.outputIndex - b.outputIndex);
      const functionCallOutputs = [];
      for (const entry of toolCallEntries) {
        res.write(
          `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
            type: 'response.function_call_arguments.done',
            item_id: entry.id,
            output_index: entry.outputIndex,
            arguments: entry.arguments,
          })}\n\n`
        );
        res.write(
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: entry.outputIndex,
            item: {
              id: entry.id,
              type: 'function_call',
              name: entry.name,
              arguments: entry.arguments,
              status: 'completed',
            },
          })}\n\n`
        );
        functionCallOutputs.push({
          id: entry.id,
          type: 'function_call',
          name: entry.name,
          arguments: entry.arguments,
          status: 'completed',
        });
      }

      // Emit terminal lifecycle events required by the Responses API spec.
      // Without these, Codex CLI does not "commit" the accumulated delta text.
      res.write(
        `event: response.output_text.done\ndata: ${JSON.stringify({
          type: 'response.output_text.done',
          item_id: msgItemId,
          output_index: 0,
          content_index: 0,
          text: fullContent,
        })}\n\n`
      );

      res.write(
        `event: response.content_part.done\ndata: ${JSON.stringify({
          type: 'response.content_part.done',
          item_id: msgItemId,
          output_index: 0,
          content_index: 0,
        })}\n\n`
      );

      res.write(
        `event: response.output_item.done\ndata: ${JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: msgItemId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: fullContent }],
          },
        })}\n\n`
      );

      const output = [];
      if (fullContent)
        output.push({
          id: msgItemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: fullContent }],
        });
      // Include function_call outputs from streaming tool calls
      for (const fc of functionCallOutputs) {
        output.push(fc);
      }
      if (fullReasoning) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: fullReasoning }] });

      res.write(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            model: responsesReq.model,
            status: 'completed',
            output,
            usage: usageInfo
              ? {
                  input_tokens: usageInfo.prompt_tokens ?? 0,
                  output_tokens: usageInfo.completion_tokens ?? 0,
                  total_tokens: usageInfo.total_tokens ?? 0,
                  input_tokens_details: { cached_tokens: usageInfo.prompt_tokens_details?.cached_tokens ?? 0 },
                  output_tokens_details: {
                    reasoning_tokens: usageInfo.completion_tokens_details?.reasoning_tokens ?? 0,
                  },
                }
              : undefined,
          },
        })}\n\n`
      );

      res.end();
      console.log(`[proxy] STREAM OK: "${fullContent.slice(0, 80)}"`);
      return;
    }

    // ── Fallback: direct proxy ────────────────────────────────────────
    let reqBody = '';
    for await (const chunk of req) {
      reqBody += chunk;
    }

    const upstreamUrl = `${UPSTREAM}${path}`;
    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: reqBody || undefined,
    });

    const data = await upstreamResp.text();
    res.writeHead(upstreamResp.status, {
      'Content-Type': upstreamResp.headers.get('content-type') || 'application/json',
    });
    res.end(data);
  } catch (err) {
    console.error(`[proxy] error:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
  }
}

// ── Port conflict handling ──────────────────────────────────────────────────

function tryListen(port, maxRetries = 10) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleRequest);
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && maxRetries > 0) {
        console.log(`[proxy] Port ${port} in use, trying ${port + 1}...`);
        srv.close();
        resolve(tryListen(port + 1, maxRetries - 1));
        return;
      }
      reject(err);
    });
    srv.listen(port, '127.0.0.1', () => {
      // Write the actual port to stdout so the parent process can read it.
      // The parent (CodexProxyManager) parses this line to discover the port.
      console.log(`[proxy] PORT=${port}`);
      console.log(`[proxy] Codex API proxy listening on http://127.0.0.1:${port}`);
      console.log(`[proxy] Upstream: ${UPSTREAM}`);
      console.log(`[proxy] Model: deepseek-v4-pro (Responses → Chat Completions with SSE streaming)`);
      resolve(srv);
    });
  });
}

tryListen(PORT).catch((err) => {
  console.error(`[proxy] Failed to start:`, err.message);
  process.exit(1);
});

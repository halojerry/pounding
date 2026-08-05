/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { type ChatFileRef, chatFileRefPath } from '@/common/types/chatFile';
import type { IMcpServer, TProviderWithModel } from '@/common/config/storage';
import { toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { emitter } from '@/renderer/utils/emitter';
import { updateWorkspaceTime } from '@/renderer/utils/workspace/workspaceHistory';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef } from 'react';
import { type TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router-dom';
import { mutate as swrMutate } from 'swr';
import { getConversationCreateErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import type { AcpModelInfo } from '../types';

export type GuidSendDeps = {
  // Input state
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: ChatFileRef[];
  setFiles: React.Dispatch<React.SetStateAction<ChatFileRef[]>>;
  dir: string;
  setDir: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loading: boolean;

  // Assistant state
  selectedAssistantId: string | null;
  selectedAssistantBackend: string;
  selectedMode: string;
  selectedAcpModel: string | null;
  selectedThoughtLevelValue?: string;
  currentAcpCachedModelInfo: AcpModelInfo | null;
  current_model: TProviderWithModel | undefined;

  guidDisabledBuiltinSkills: string[] | undefined;
  guidEnabledSkills: string[] | undefined;
  assistantDefaultSkillIds: string[] | undefined;
  assistantDefaultDisabledBuiltinSkillIds: string[] | undefined;
  assistantDefaultMcpIds: string[] | undefined;
  availableMcpServers: IMcpServer[];
  selectedMcpServerIds: string[] | undefined;
  isGoogleAuth: boolean;

  // Mention state reset
  setMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setMentionSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionActiveIndex: React.Dispatch<React.SetStateAction<number>>;

  // Navigation
  navigate: NavigateFunction;
  t: TFunction;
  localeKey: string;
  is_preset?: boolean; // POUNDING: whether selected assistant is a preset/builtin
};

export type GuidSendResult = {
  handleSend: () => Promise<void>;
  sendMessageHandler: () => void;
  isButtonDisabled: boolean;
};

/**
 * Hook that manages the send logic for all conversation types (openclaw/nanobot/acp).
 */
export const useGuidSend = (deps: GuidSendDeps): GuidSendResult => {
  const {
    input,
    setInput,
    files,
    setFiles,
    dir,
    setDir,
    setLoading,
    loading,
    selectedAssistantId,
    selectedAssistantBackend,
    selectedMode,
    selectedAcpModel,
    selectedThoughtLevelValue,
    currentAcpCachedModelInfo,
    current_model,
    guidDisabledBuiltinSkills,
    guidEnabledSkills,
    availableMcpServers,
    selectedMcpServerIds,
    assistantDefaultMcpIds,
    assistantDefaultSkillIds,
    assistantDefaultDisabledBuiltinSkillIds,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    navigate,
    t,
    localeKey,
    is_preset = false,
  } = deps;
  const sendingRef = useRef(false);

  const handleSend = useCallback(async () => {
    if (!selectedAssistantId) {
      return;
    }

    const isCustomWorkspace = !!dir;
    const finalWorkspace = dir || '';

    const assistantConversationId = selectedAssistantId;
    const assistantBackend = selectedAssistantBackend;
    const enabled_skills_to_send = guidEnabledSkills ?? assistantDefaultSkillIds;
    const excludeBuiltinSkills = guidDisabledBuiltinSkills ?? assistantDefaultDisabledBuiltinSkillIds;
    const selectedAllMcpServerIds = selectedMcpServerIds ?? [];
    const selectedMcpServerIdSet = new Set(selectedAllMcpServerIds);
    const selectedUserMcpServerIds = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin !== true)
      .map((server) => server.id);
    const selectedAllSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id))
      .map((server) => toSessionMcpServer(server));
    const selectedSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin === true)
      .map((server) => toSessionMcpServer(server));
    const assistantOverrideMcpIds = selectedAllMcpServerIds;
    const selectedUserMcpServerIdsToSend = selectedUserMcpServerIds;
    const selectedSessionMcpServersToSend = selectedSessionMcpServers;

    // `current_model` is the aionrs provider selection and means nothing to a
    // CLI agent, which owns its own model list. Used as a blanket fallback it
    // leaked into the FIRST turn of every CLI conversation: before the agent's
    // catalog has been probed the two preceding options are empty, so a brand
    // new Antigravity conversation started with e.g. `gemini-3.1-pro-preview`
    // — a provider model agy has never heard of — and the turn failed with
    // USER_LLM_PROVIDER_MODEL_NOT_FOUND. Once the catalog lands the second
    // option wins, which is why it only ever reproduced on first use.
    //
    // Omitting it lets the agent start on its own default, which is what a user
    // who has not picked a model means. The cron dialog already gates the same
    // value this way (`resolvedBackend !== 'aionrs' → undefined`).
    const assistantOverrideModel =
      selectedAcpModel ||
      currentAcpCachedModelInfo?.current_model_id ||
      (assistantBackend === 'aionrs' ? current_model?.use_model : undefined) ||
      undefined;
    const assistantOverrides = {
      model: assistantOverrideModel,
      permission: selectedMode || undefined,
      thought_level: selectedThoughtLevelValue || undefined,
      skill_ids: enabled_skills_to_send,
      disabled_builtin_skill_ids: excludeBuiltinSkills,
      mcp_ids: assistantOverrideMcpIds,
    };

    if (assistantBackend === 'aionrs') {
      if (!current_model) {
        Message.warning(t('conversation.noModelConfigured'));
        return;
      }
      try {
        const conversation = await ipcBridge.conversation.create.invoke({
          name: input,
          model: current_model,
          assistant: {
            id: assistantConversationId,
            locale: localeKey,
            conversation_overrides: assistantOverrides,
          },
          extra: {
            default_files: files.map(chatFileRefPath),
            workspace: finalWorkspace,
            custom_workspace: isCustomWorkspace,
            selected_mcp_server_ids: selectedUserMcpServerIdsToSend,
            selected_session_mcp_servers: selectedSessionMcpServersToSend,
          },
        });

        if (!conversation || !conversation.id) {
          alert('Failed to create POUNDING CLI conversation. Please ensure aionrs is installed.');
          return;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        if (assistantConversationId) {
          await Promise.all([
            swrMutate(`guid.assistant.detail.${assistantConversationId}.${localeKey}`),
            swrMutate('assistants.list'),
          ]);
        }

        emitter.emit('chat.history.refresh');

        const initialMessage = {
          input,
          files: files.length > 0 ? files : undefined,
        };
        sessionStorage.setItem(`aionrs_initial_message_${conversation.id}`, JSON.stringify(initialMessage));

        await navigate(`/conversation/${conversation.id}`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        alert(`Failed to create POUNDING CLI conversation: ${errorMessage}`);
        throw error;
      }
      return;
    }

    try {
      const conversation = await ipcBridge.conversation.create.invoke({
        name: input,
        assistant: {
          id: assistantConversationId,
          locale: localeKey,
          conversation_overrides: assistantOverrides,
        },
        extra: {
          workspace: finalWorkspace,
          custom_workspace: isCustomWorkspace,
          default_files: files.map(chatFileRefPath),
          exclude_auto_inject_skills: excludeBuiltinSkills,
          selected_mcp_server_ids: selectedUserMcpServerIdsToSend,
          selected_session_mcp_servers: selectedSessionMcpServersToSend,
          // Non-preset agents still forward user-selected custom skills via the
          // shared backend slot. For preset assistants this is already wired
          // through `preset_resources.enabled_skills` above.
          ...(is_preset ? {} : guidEnabledSkills?.length ? { preset_enabled_skills: guidEnabledSkills } : {}),
        },
      });
      if (!conversation || !conversation.id) {
        console.error('Failed to create ACP conversation - conversation object is null or missing id');
        return;
      }

      if (isCustomWorkspace) {
        updateWorkspaceTime(finalWorkspace);
      }

      if (assistantConversationId) {
        await Promise.all([
          swrMutate(`guid.assistant.detail.${assistantConversationId}.${localeKey}`),
          swrMutate('assistants.list'),
        ]);
      }

      emitter.emit('chat.history.refresh');

      const initialMessage = {
        input,
        files: files.length > 0 ? files : undefined,
      };
      sessionStorage.setItem(`acp_initial_message_${conversation.id}`, JSON.stringify(initialMessage));

      await navigate(`/conversation/${conversation.id}`);
    } catch (error: unknown) {
      console.error('Failed to create ACP conversation:', error);
      throw error;
    }
  }, [
    input,
    files,
    dir,
    selectedAssistantId,
    selectedAssistantBackend,
    selectedMode,
    selectedAcpModel,
    selectedThoughtLevelValue,
    currentAcpCachedModelInfo,
    current_model,
    guidDisabledBuiltinSkills,
    availableMcpServers,
    selectedMcpServerIds,
    navigate,
    t,
    localeKey,
    is_preset,
  ]);

  const sendMessageHandler = useCallback(() => {
    if (loading || sendingRef.current) return;
    sendingRef.current = true;
    setLoading(true);
    handleSend()
      .then(() => {
        setInput('');
        setMentionOpen(false);
        setMentionQuery(null);
        setMentionSelectorOpen(false);
        setMentionActiveIndex(0);
        setFiles([]);
        setDir('');
      })
      .catch((error) => {
        console.error('Failed to send message:', error);
      })
      .finally(() => {
        sendingRef.current = false;
        setLoading(false);
      });
  }, [
    loading,
    handleSend,
    setLoading,
    setInput,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    setFiles,
    setDir,
  ]);

  // Calculate button disabled state
  const isButtonDisabled = loading || !input.trim() || !selectedAssistantId;

  return {
    handleSend,
    sendMessageHandler,
    isButtonDisabled,
  };
};

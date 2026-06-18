#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
import uuid
from urllib.request import urlopen
from datetime import datetime
from pathlib import Path
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from scripts._const import DATA_DIR, DEFAULT_CACHE_TTL_SECONDS, get_config_profile

_CACHE_TTL = DEFAULT_CACHE_TTL_SECONDS  # 24h — reuse cached probe results within this window
from scripts._errors import ConfigError, ValidationError
from scripts.lib.reference_images import is_likely_product_image
from scripts.lib.task_paths import current_task_id, task_media_dir


EXTRACT_1688_JS = r"""
() => {
  // Trigger lazy-load DOM by scrolling
  try {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'instant' });
  } catch(e) {}

  const normalizeText = (value) => {
    if (value == null) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || null;
  };
  const cleanUrl = (value) => {
    if (!value) return null;
    try {
      return new URL(value, location.href).toString();
    } catch {
      return normalizeText(value);
    }
  };
  const cleanImageUrl = (value) => {
    const url = cleanUrl(value);
    if (!url) return null;
    return url
      .replace(/\.webp$/i, '.jpg')
      .replace(/\.jpg_(sum|b)\.jpg$/i, '.jpg')
      .replace(/_(sum|b)\.jpg$/i, '.jpg')
      .replace(/_\d+x\d+\.jpg$/i, '.jpg')
      .replace(/_\d+q\d+\.jpg$/i, '.jpg')
      .replace(/\.jpg\.jpg$/i, '.jpg')
      .replace(/_88x88q90/i, '');
  };
  const dedupe = (items) => {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      const key = typeof item === 'string' ? item : JSON.stringify(item, Object.keys(item || {}).sort());
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };
  const queryAll = (selectors, root = document) => {
    const out = [];
    for (const selector of selectors) {
      try { root.querySelectorAll(selector).forEach((el) => out.push(el)); } catch {}
    }
    return out;
  };
  const pickText = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const el = root.querySelector(selector);
        const text = normalizeText(el?.innerText || el?.textContent);
        if (text) return text;
      } catch {}
    }
    return null;
  };
  const pickTextFrom = (root, selectors) => {
    for (const selector of selectors) {
      try {
        const el = root?.querySelector?.(selector);
        const text = normalizeText(el?.innerText || el?.textContent);
        if (text) return text;
      } catch {}
    }
    return null;
  };
  const pickAttr = (selectors, attr, root = document) => {
    for (const selector of selectors) {
      try {
        const el = root.querySelector(selector);
        const val = el?.getAttribute?.(attr) || el?.[attr];
        if (val) return val;
      } catch {}
    }
    return null;
  };
  const pickAttrFrom = (root, selectors, attr) => {
    for (const selector of selectors) {
      try {
        const el = root?.querySelector?.(selector);
        const val = el?.getAttribute?.(attr) || el?.[attr];
        if (val) return val;
      } catch {}
    }
    return null;
  };
  const parseNumber = (value) => {
    if (value == null) return null;
    const text = String(value).replace(/,/g, '.');
    const match = text.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  };
  const parseInteger = (value) => {
    if (value == null) return null;
    const digits = String(value).replace(/[^\d]/g, '');
    return digits ? Number(digits) : null;
  };
  const readImages = (selectors, root = document, limit = 100) => {
    const items = [];
    queryAll(selectors, root).forEach((el) => {
      const src = cleanImageUrl(
        el?.currentSrc || el?.src || el?.getAttribute?.('src') || el?.getAttribute?.('data-src') || el?.getAttribute?.('data-lazy-src') || el?.getAttribute?.('data-lazyload-src') || el?.getAttribute?.('data-original')
      );
      if (!src) return;
      if (/data:image|placeholder|icon|logo|sprite|avatar|loading/i.test(src)) return;
      if (/!!0-0-|_88x88/i.test(src)) return;
      items.push(src);
    });
    return dedupe(items).slice(0, limit);
  };
  const readResourceImages = (limit = 150) => {
    const items = [];
    try {
      const resources = performance.getEntriesByType('resource') || [];
      resources.forEach((entry) => {
        const src = cleanImageUrl(entry?.name);
        if (!src) return;
        if (!/alicdn\.com\/img\/ibank|cbu01\.alicdn|1688|alibaba|cib\.jpg/i.test(src)) return;
        if (/data:image|placeholder|icon|logo|sprite|avatar|loading|!!0-0-|_88x88|_24x24|_48x48|svg/i.test(src)) return;
        items.push(src);
      });
    } catch {}
    return dedupe(items).slice(0, limit);
  };
  const readPairsBySelectors = (rowSelectors, keySelectors, valueSelectors, root = document, limit = 100) => {
    const pairs = [];
    queryAll(rowSelectors, root).forEach((row) => {
      const name = pickTextFrom(row, keySelectors);
      const value = pickTextFrom(row, valueSelectors);
      if (name && value && name !== value && value.length < 500) pairs.push({ name, value });
    });
    return dedupe(pairs).slice(0, limit);
  };
  const readAntDescriptionsPairs = (root = document, limit = 100) => {
    const pairs = [];
    queryAll(['.module-od-product-attributes .ant-descriptions-row', '#productAttributes .ant-descriptions-row', '.ant-descriptions-row'], root).forEach((row) => {
      const labels = Array.from(row.querySelectorAll('.ant-descriptions-item-label')).map((cell) => normalizeText(cell.innerText || cell.textContent));
      const values = Array.from(row.querySelectorAll('.ant-descriptions-item-content')).map((cell) => normalizeText(cell.innerText || cell.textContent));
      const size = Math.min(labels.length, values.length);
      for (let index = 0; index < size; index += 1) {
        const name = labels[index];
        const value = values[index];
        if (name && value && name !== value && value.length < 500) {
          pairs.push({ name, value });
        }
      }
    });
    return dedupe(pairs).slice(0, limit);
  };
  const readDescriptionBlock = (selectors) => {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        const text = normalizeText(el?.innerText || el?.textContent);
        if (text && text.length > 20) return text;
      } catch {}
    }
    return null;
  };
  const findReactFiber = (node) => {
    if (!node) return null;
    const names = [];
    try { names.push(...Object.getOwnPropertyNames(node)); } catch {}
    try { names.push(...Object.keys(node)); } catch {}
    for (const key of names) {
      if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
        try { return node[key]; } catch {}
      }
    }
    return null;
  };
  const getWindowInitData = () => {
    try { return globalThis.__INIT_DATA__ || window.__INIT_DATA__ || null; } catch { return null; }
  };
  const safeJsonSample = (value, limit = 4000) => {
    if (value == null) return null;
    try {
      const json = JSON.stringify(value);
      if (!json) return null;
      return json.length > limit ? json.slice(0, limit) : json;
    } catch {
      return null;
    }
  };
  const deepFindDimensionLike = (value, path = [], depth = 0, out = []) => {
    if (value == null || depth > 4 || out.length >= 40) return out;
    if (typeof value === 'string') {
      const keyPath = path.join('.').toLowerCase();
      const raw = value.trim();
      if (!raw) return out;
      if (/(尺寸|规格|长|宽|高|直径|口径|size|spec|dimension|length|width|height|diameter)/i.test(keyPath) || /\d+(?:\.\d+)?\s*(cm|mm|厘米|毫米)/i.test(raw)) {
        out.push({ path: path.join('.'), value: raw });
      }
      return out;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return out;
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, index) => deepFindDimensionLike(item, path.concat(String(index)), depth + 1, out));
      return out;
    }
    if (typeof value === 'object') {
      Object.entries(value).slice(0, 40).forEach(([key, item]) => {
        deepFindDimensionLike(item, path.concat(String(key)), depth + 1, out);
      });
    }
    return out;
  };
  const collectPageStructuredData = () => {
    const candidates = [];
    const addCandidate = (name, value) => {
      if (value == null) return;
      const sample = safeJsonSample(value);
      const dimensionHints = deepFindDimensionLike(value, [name]);
      const keys = (value && typeof value === 'object' && !Array.isArray(value)) ? Object.keys(value).slice(0, 20) : [];
      if (sample || dimensionHints.length || keys.length) {
        candidates.push({ name, keys, sample, dimensionHints });
      }
    };
    addCandidate('__INIT_DATA__', getWindowInitData());
    try { addCandidate('globalData', window.globalData || globalThis.globalData || null); } catch {}
    try { addCandidate('__PRELOADED_STATE__', window.__PRELOADED_STATE__ || globalThis.__PRELOADED_STATE__ || null); } catch {}
    try { addCandidate('__NUXT__', window.__NUXT__ || globalThis.__NUXT__ || null); } catch {}
    return candidates.slice(0, 10);
  };
  const extractRuntimeSkuData = () => {
    const roots = [
      document.querySelector('.pc-sku-wrapper'),
      document.querySelector('.gyp-sku-selection-order-button-wrap'),
      document.querySelector('.pc-sku-gyp-more-dimension-wrapper'),
      document.querySelector('.cart-sider'),
    ].filter(Boolean);
    const fromPanel = (fiber) => {
      const props = fiber?.child?.memoizedProps || fiber?.memoizedProps || {};
      const panel = props?.skuPannelInfo;
      if (!panel || !panel.getData || !panel.getSubmitData) return null;
      const selected = panel.getSelected?.()?.selectedSku || {};
      const imageMap = {};
      const rawSkuProps = panel?._state?.skuProps || panel.getData?.()?.skuProps || [];
      if (Array.isArray(rawSkuProps)) {
        rawSkuProps.forEach((group) => {
          (group?.value || []).forEach((item) => {
            if (item?.name && item?.imageUrl) imageMap[item.name] = cleanImageUrl(item.imageUrl);
          });
        });
      }
      const data = panel.getData() || {};
      const skuSpecIdMap = data.skuSpecIdMap || {};
      const submit = panel.getSubmitData() || {};
      const priceRanges = Array.isArray(data.priceRanges) ? data.priceRanges : [];
      const totalQty = Array.isArray(submit.submitData) ? submit.submitData.reduce((sum, row) => sum + Number(row?.quantity || 0), 0) : 0;
      let activePrice = null;
      for (const range of priceRanges) {
        if (totalQty >= Number(range?.beginAmount || 0)) activePrice = range?.price ?? activePrice;
      }
      let sku = Object.keys(selected).filter((key) => Number(selected[key]) > 0).map((key) => {
        const item = skuSpecIdMap[key] || {};
        return {
          specId: item.specId || key,
          skuId: item.skuId || item.specId || key,
          name: normalizeText(item.specAttrs || item.name || key),
          specAttrs: normalizeText(item.specAttrs || item.name || key),
          canBookCount: item.canBookCount ?? null,
          skuCount: Number(selected[key] || 0),
          firstProp: normalizeText(item.firstProp || null),
          image: cleanImageUrl(imageMap[item.firstProp]) || null,
          price: parseNumber(item.discountPrice ?? item.price ?? activePrice),
          discountPrice: parseNumber(item.discountPrice),
        };
      });
      if ((!sku || sku.length === 0) && Array.isArray(submit.submitData)) {
        sku = submit.submitData.map((row, index) => ({
          specId: row?.specId || `submit-${index + 1}`,
          skuId: row?.skuId || row?.specId || `submit-${index + 1}`,
          name: normalizeText(row?.specAttrs || row?.name || `规格${index + 1}`),
          specAttrs: normalizeText(row?.specAttrs || row?.name || `规格${index + 1}`),
          canBookCount: row?.canBookCount ?? null,
          skuCount: Number(row?.quantity || 0),
          firstProp: null,
          image: null,
          price: parseNumber(activePrice),
          discountPrice: null,
        }));
      }
      return { success: submit.success !== false, message: normalizeText(submit.message) || null, selectedSkuMap: selected, priceRanges, imageMap, sku };
    };
    const fromMoreDimension = (fiber) => {
      try {
        const orderList = fiber?.memoizedProps?.children?.[1]?.props?.orderList || [];
        const sku = orderList.map((row) => ({
          specId: row?.props?.specId || null,
          skuId: row?.props?.skuId || row?.props?.specId || null,
          name: normalizeText((row?.props?.map || []).map((item) => item?.value).join('-')),
          specAttrs: normalizeText((row?.props?.map || []).map((item) => item?.value).join('-')),
          canBookCount: row?.props?.canBookCount ?? null,
          skuCount: Number(row?.props?.amount || 0),
          image: null,
          price: parseNumber(row?.props?.price),
          discountPrice: null,
        })).filter((item) => item.name || item.skuId);
        return sku.length ? { success: true, message: null, selectedSkuMap: {}, priceRanges: [], imageMap: {}, sku } : null;
      } catch { return null; }
    };
    const fromCartSider = (fiber) => {
      try {
        const children = fiber?.memoizedProps?.children || [];
        const submitOrderNode = children[children.length - 1]?.find?.((item) => item?.key === 'submitOrder');
        const props = submitOrderNode?.props?.data?.props;
        const mapperKey = Object.getOwnPropertySymbols(props?.dataManager || {}).find((key) => String(key).includes('mapper'));
        const mapper = mapperKey ? props?.dataManager?.[mapperKey] : null;
        const orderAmounts = props?.selectedOrder?.orderAmounts || {};
        const featureItems = (props?.dataManager?.params?.featureItems || []).flatMap((item) => item?.dataList || []).filter((item) => item?.imageUrl);
        let activePrice = null;
        const priceRanges = props?.dataManager?.params?.saleOptions?.priceRanges || [];
        if (props?.dataManager?.params?.saleOptions?.priceRangeMode && Array.isArray(priceRanges)) {
          const totalCount = Number(props?.selectedOrder?.totalCount || 0);
          priceRanges.forEach((range) => { if (totalCount >= Number(range?.beginAmount || 0)) activePrice = range?.price ?? activePrice; });
        }
        const sku = Object.keys(orderAmounts).map((key) => {
          const item = mapper?.[key] || {};
          const image = featureItems.find((entry) => normalizeText(item?.specAttrs || '').includes(normalizeText(entry?.label || '')))?.imageUrl || null;
          return {
            specId: item.specId || key,
            skuId: item.skuId || item.specId || key,
            name: normalizeText(item.specAttrs || key),
            specAttrs: normalizeText(item.specAttrs || key),
            canBookCount: item.canBookCount ?? null,
            skuCount: Number(orderAmounts[key] || 0),
            image: cleanImageUrl(image),
            price: parseNumber(activePrice || item.priceNum || item.price),
            discountPrice: null,
          };
        }).filter((item) => item.name || item.skuId);
        return sku.length ? { success: true, message: null, selectedSkuMap: orderAmounts, priceRanges, imageMap: {}, sku } : null;
      } catch { return null; }
    };
    for (const root of roots) {
      const fiber = findReactFiber(root);
      if (!fiber) continue;
      const result = fromPanel(fiber) || fromMoreDimension(fiber) || fromCartSider(fiber);
      if (result) return result;
    }
    return { success: false, message: 'runtime sku unavailable', selectedSkuMap: {}, priceRanges: [], imageMap: {}, sku: [] };
  };
  const images = dedupe([
    ...readImages([
      '.gallery-img img', '.main-image img', '.detail-gallery-img img', '.thumb-img img', '.thumbnail img', '.detail-gallery img',
      '.preview-list img', '.fd-clr img', '.od-pc-offer-tab img', '.offer-detail-tab img', '.main-pic img', '.pic-view img',
      '.preview-wrap img', '.detail-pic img', '.product-image img', '.offer-image img', '.main-img img', '.img-list img',
      "img[src*='alicdn']", "img[src*='1688']", "img[src*='alibaba']"
    ], document, 120),
    ...readResourceImages(120),
  ]).slice(0, 120);
  const productAttributePairs = dedupe([
    ...readAntDescriptionsPairs(document, 120),
    ...readPairsBySelectors(
      ['.module-od-product-attributes .ant-descriptions-row'],
      ['.ant-descriptions-item-label span'],
      ['.ant-descriptions-item-content .field-value', '.ant-descriptions-item-content']
    ),
  ]);
  const attributes = dedupe([
    ...productAttributePairs,
    ...readPairsBySelectors(['.offer-attr-item'], ['.offer-attr-item-name'], ['.offer-attr-item-value']),
    ...readPairsBySelectors(['#productAttributes .ant-descriptions-row', '.ant-descriptions-row'], ['.ant-descriptions-item-label span'], ['.ant-descriptions-item-content .field-value', '.ant-descriptions-item-content']),
    ...readPairsBySelectors(['.attr-item', '.product-attr-item'], ['.attr-name', '.attr-key'], ['.attr-value']),
    ...readPairsBySelectors(['.attr-table tr', '.product-params tr', 'table tr'], ['th', 'td:first-child'], ['td:last-child'])
  ]);
  // 收集所有 SKU 图片：从 DOM 按钮 + performance resources 双向覆盖
  const skuImageMap = {};
  queryAll(['.sku-filter-button img', '.sku-filter-button .ant-image-img']).forEach((img) => {
    const label = normalizeText(img.closest('.sku-filter-button')?.querySelector('.label-name')?.innerText || img.alt || '');
    const src = cleanImageUrl(img.src || img.getAttribute('src'));
    if (label && src) skuImageMap[label] = src;
  });

  const optionGroups = [];
  /* Scan SKU containers: .feature-item and .transverse-filter */
const skuContainers = [
  ...queryAll(['.module-od-sku-selection .feature-item']),
  ...queryAll(['.transverse-filter']),
];
skuContainers.forEach((featureEl, featureIndex) => {
    const groupName = pickTextFrom(featureEl, ['.feature-item-label h3', '.feature-item-label', 'h3']) || `规格组${featureIndex + 1}`;
    const values = [];
    queryAll(['.sku-filter-button', '.prop-item-inner-wrapper', '.selector-prop-item', '.expand-view-item'], featureEl).forEach((el) => {
      const name = pickTextFrom(el, ['.label-name', '.prop-name', '.prop-item-text', 'span']) || normalizeText(el.getAttribute?.('title'));
      let image = cleanImageUrl(pickAttrFrom(el, ['img'], 'src'));
      if (!image) {
        const bgEl = el.querySelector('.prop-img, .sku-item-image, .single-sku-img-pop');
        const bg = bgEl ? window.getComputedStyle(bgEl).backgroundImage : '';
        const match = bg && bg.match(/https?:[^)"]+/i);
        if (match) image = cleanImageUrl(match[0]);
      }
      if (name) {
        if (!image) image = skuImageMap[name] || null;
        values.push({ name, image: image || null });
      }
    });
    queryAll(['.expand-view-item'], featureEl).forEach((el) => {
      const name = pickTextFrom(el, ['.item-label', 'span']) || null;
      const price = pickTextFrom(el, ['.item-price-stock', '.price']) || null;
      if (name) values.push({ name, image: null, price: parseNumber(price) });
    });
    const dedupedValues = dedupe(values);
    if (dedupedValues.length) optionGroups.push({ name: groupName, values: dedupedValues });
  });

  const packagingRows = [];
  const packagingTable = document.querySelector('.module-od-product-pack-info table');
  const packagingHeaders = Array.from(packagingTable?.querySelectorAll?.('thead th') || []).map((cell) => normalizeText(cell.innerText || cell.textContent));
  const packagingTableText = normalizeText(packagingTable?.innerText || packagingTable?.textContent);
  const packagingWeightIndex = packagingHeaders.findIndex((header) => /重量|毛重|净重|weight/i.test(header || ''));
  const packagingLengthIndex = packagingHeaders.findIndex((header) => /(^|[^总])长\s*\(?\s*(cm|mm)?\s*\)?$|长度|length/i.test(header || ''));
  const packagingWidthIndex = packagingHeaders.findIndex((header) => /宽\s*\(?\s*(cm|mm)?\s*\)?$|宽度|width/i.test(header || ''));
  const packagingHeightIndex = packagingHeaders.findIndex((header) => /高\s*\(?\s*(cm|mm)?\s*\)?$|高度|height/i.test(header || ''));
  const packagingSpecIndex = packagingHeaders.findIndex((header) => /规格|尺码|spec|size/i.test(header || ''));
  const packagingColorIndex = packagingHeaders.findIndex((header) => /颜色|色系|color/i.test(header || ''));
  queryAll(['.module-od-product-pack-info table tbody tr']).forEach((row) => {
    const cells = Array.from(row.querySelectorAll('td')).map((cell) => normalizeText(cell.innerText || cell.textContent));
    if (cells.length >= 1) {
      const rowData = {
        color: packagingColorIndex >= 0 && packagingColorIndex < cells.length ? cells[packagingColorIndex] : (cells.length >= 1 ? cells[0] : null),
        capacity: packagingSpecIndex >= 0 && packagingSpecIndex < cells.length ? cells[packagingSpecIndex] : (cells.length >= 2 ? cells[1] : null),
        weightText: packagingWeightIndex >= 0 && packagingWeightIndex < cells.length ? cells[packagingWeightIndex] : null,
        weightGrams: packagingWeightIndex >= 0 && packagingWeightIndex < cells.length ? parseInteger(cells[packagingWeightIndex]) : null,
        lengthText: packagingLengthIndex >= 0 && packagingLengthIndex < cells.length ? cells[packagingLengthIndex] : null,
        widthText: packagingWidthIndex >= 0 && packagingWidthIndex < cells.length ? cells[packagingWidthIndex] : null,
        heightText: packagingHeightIndex >= 0 && packagingHeightIndex < cells.length ? cells[packagingHeightIndex] : null,
      };
      if (cells.length === 1 && packagingWeightIndex === 0) {
        rowData.color = null;
        rowData.capacity = null;
        rowData.weightText = cells[0];
        rowData.weightGrams = parseInteger(cells[0]);
      }
      packagingRows.push(rowData);
    }
  });

  const skuDetails = [];
  const addSku = (name, price, image) => {
    const cleanName = normalizeText(name);
    if (!cleanName) return;
    skuDetails.push({ name: cleanName, price: parseNumber(price), image: cleanImageUrl(image) });
  };
  queryAll(['.sku-item-wrapper']).forEach((el, index) => {
    addSku(pickTextFrom(el, ['.sku-item-name', '.sku-item-name-text', 'span']) || `规格${index + 1}`, pickTextFrom(el, ['.discountPrice-price', '.sku-item-price', '.price']), pickAttrFrom(el, ['.sku-item-img img', '.sku-wrapper-img img', 'img'], 'src'));
  });
  queryAll(['.expand-view-item', '.sku-list-item', '.single-sku-list-wrap']).forEach((el, index) => {
    addSku(pickTextFrom(el, ['.item-label', '.sku-item-name-text', '.single-sku-title span:nth-child(2)', 'span']) || `规格${index + 1}`, pickTextFrom(el, ['.item-price-stock', '.sku-item-price', '.single-price-warp .price-title', '.price']), pickAttrFrom(el, ['img'], 'src'));
  });
  queryAll(['.next-table-body table tr']).forEach((el, index) => {
    addSku(pickTextFrom(el, ['span.normal-text', 'td span', 'td']) || `规格${index + 1}`, pickTextFrom(el, ['.price', 'td:last-child', 'td']), null);
  });
  const runtimeSkuData = extractRuntimeSkuData();
  const initData = getWindowInitData();
  const pageStructuredData = collectPageStructuredData();
  const title = pickText(['.title-text', '.title-content', 'h1', '.d-title']) || normalizeText(document.title);
  const price = pickText(['.price-now', '.discountPrice-price', '.price', '.current-price', '.item-price-stock', '.ma-ref-price']) || (runtimeSkuData.sku?.[0]?.price != null ? String(runtimeSkuData.sku[0].price) : null);
  const seller = pickText(['a[href*="company"]', '.company-name', '[class*="company"] a', '[class*="shop"] a', '.header-shop-name', '.shop-name']);
  const sellerLink = cleanUrl(pickAttr(['a[href*="company"]', '[class*="company"] a', '[class*="shop"] a'], 'href'));
  const minOrderQtyText = pickText(['.moq-number', '.quantity-range', '.lt-spec-num', '[class*="moq"]']) || attributes.find((item) => /起订|最小|采购量|minimum/i.test(item.name || ''))?.value || null;
  const brand = pickText(['a[href*="brand"]', '[class*="brand"]']) || attributes.find((item) => /品牌/i.test(item.name || ''))?.value || null;
  const origin = attributes.find((item) => /产地|origin/i.test(item.name || ''))?.value || null;
  const model = attributes.find((item) => /型号|model/i.test(item.name || ''))?.value || null;
  const description = readDescriptionBlock(['#detailContentContainer', '.html-description', '.offer-detail-tab']);
  const bodyText = (document.body?.innerText || document.body?.textContent || '').slice(0, 3000);
  const hasStrongProductSignals = Boolean(
    title && images.length > 0 && (
      attributes.length >= 3 ||
      optionGroups.length > 0 ||
      packagingRows.length > 0 ||
      skuDetails.length > 0 ||
      (runtimeSkuData?.sku?.length || 0) > 0
    )
  );
  const loginRequired = !hasStrongProductSignals && (
    /passport|login|member\.1688\.com/i.test(location.href) ||
    /扫码登录|密码登录|短信登录/i.test(bodyText) ||
    (/登录|login/i.test(bodyText) && !title)
  );
  return {
    site: '1688',
    url: location.href,
    loginRequired,
    title,
    price,
    priceValue: parseNumber(price),
    brand,
    seller,
    sellerLink,
    image: images[0] || null,
    images,
    video: cleanUrl(pickAttr(['video source', '.video-player source', 'video'], 'src')),
    minOrderQty: minOrderQtyText,
    minOrderQtyValue: parseInteger(minOrderQtyText),
    origin,
    model,
    attributes,
    optionGroups,
    packagingHeaders,
    packagingTableText,
    packagingRows: dedupe(packagingRows),
    skuDetails: dedupe(skuDetails),
    runtimeSkuData,
    pageStructuredData,
    description,
    sourceHints: {
      productAttributeCount: productAttributePairs.length,
      attributeCount: attributes.length,
      optionGroupCount: optionGroups.length,
      skuCount: skuDetails.length,
      imageCount: images.length,
      runtimeSkuCount: runtimeSkuData?.sku?.length || 0,
      runtimeImageMappingCount: Object.keys(runtimeSkuData?.imageMap || {}).length,
      initDataKeys: Object.keys((initData && typeof initData === 'object') ? initData : {}).slice(0, 20),
      pageStructuredDataCount: pageStructuredData.length,
      packagingHeaderCount: packagingHeaders.length,
      packagingTableTextLength: packagingTableText ? packagingTableText.length : 0,
    },
  };
}
"""


def _profile_dir(profile: str) -> Path:
    path = DATA_DIR / 'browser' / 'profiles' / '1688' / profile
    path.mkdir(parents=True, exist_ok=True)
    return path


def _candidate_browser_paths() -> list[str]:
    import platform
    system = platform.system()

    paths = [
        'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'msedge',
    ]

    if system == 'Darwin':
        paths.extend([
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ])
    elif system == 'Windows':
        # shutil.which handles PATH-located executables; add common install dirs
        import os as _os
        for base in [
            _os.environ.get('ProgramFiles', 'C:\\Program Files'),
            _os.environ.get('ProgramFiles(x86)', 'C:\\Program Files (x86)'),
            _os.environ.get('LOCALAPPDATA', ''),
        ]:
            if base:
                paths.extend([
                    f'{base}\\Google\\Chrome\\Application\\chrome.exe',
                    f'{base}\\Microsoft\\Edge\\Application\\msedge.exe',
                ])

    # Playwright-bundled Chromium (no system Chrome needed) — all platforms
    paths.extend(_playwright_chromium_paths())
    return paths


def _playwright_chromium_paths() -> list[str]:
    """Find Playwright's bundled Chromium — fallback when no system Chrome."""
    import platform
    home = Path.home()
    if platform.system() == 'Darwin':
        cache_dir = home / 'Library' / 'Caches' / 'ms-playwright'
        suffix = 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
    elif platform.system() == 'Linux':
        cache_dir = home / '.cache' / 'ms-playwright'
        suffix = 'chrome-linux/chrome'
    elif platform.system() == 'Windows':
        cache_dir = Path(os.environ.get('LOCALAPPDATA', home / 'AppData' / 'Local')) / 'ms-playwright'
        suffix = 'chrome-win/chrome.exe'
    else:
        return []

    paths: list[str] = []
    if cache_dir.is_dir():
        for entry in sorted(cache_dir.iterdir(), reverse=True):
            if entry.name.startswith('chromium-'):
                candidate = entry / suffix
                if candidate.exists():
                    paths.append(str(candidate))
    return paths


def find_browser_executable(explicit: str | None = None) -> str | None:
    candidate = str(explicit or '').strip()
    if candidate:
        path = Path(candidate).expanduser()
        if path.exists():
            return str(path)
        found = shutil.which(candidate)
        if found:
            return found
        raise ConfigError(f'浏览器可执行文件不存在: {candidate}')
    for item in _candidate_browser_paths():
        found = shutil.which(item)
        if found:
            return found
        path = Path(item)
        if path.exists():
            return str(path)
    return None


def _build_summary(probe: dict[str, Any]) -> dict[str, Any]:
    return {
        'title': probe.get('title'),
        'price': probe.get('price'),
        'brand': probe.get('brand'),
        'seller': probe.get('seller'),
        'image_count': len(probe.get('images') or []),
        'attribute_count': len(probe.get('attributes') or []),
        'dom_sku_count': len(probe.get('skuDetails') or []),
        'runtime_sku_count': len((probe.get('runtimeSkuData') or {}).get('sku') or []),
        'login_required': bool(probe.get('loginRequired')),
    }


def _has_strong_product_signals(probe: dict[str, Any] | None) -> bool:
    if not isinstance(probe, dict):
        return False
    return bool(
        probe.get('title')
        and len(probe.get('images') or []) > 0
        and (
            len(probe.get('attributes') or []) >= 3
            or len(probe.get('optionGroups') or []) > 0
            or len(probe.get('packagingRows') or []) > 0
            or len(probe.get('skuDetails') or []) > 0
            or len((probe.get('runtimeSkuData') or {}).get('sku') or []) > 0
        )
    )


def _looks_like_failure_page(probe: dict[str, Any] | None) -> bool:
    if not isinstance(probe, dict):
        return True
    url = str(probe.get('url') or '').lower()
    title = str(probe.get('title') or '').lower()
    description = str(probe.get('description') or '').lower()
    body_hints = ' '.join([
        title,
        description,
        str((probe.get('seller') or '')).lower(),
        str((probe.get('error') or '')).lower(),
    ])
    failure_tokens = [
        'wrongpage',
        'notfound',
        'page.1688.com/shtml/static/wrongpage',
        'spm=a260k.24848612.notfound',
        '404',
        '页面不存在',
        '商品不存在',
        '不存在或已下架',
    ]
    if any(token in url or token in body_hints for token in failure_tokens):
        return True
    if 'login.taobao.com' in url or 'login.1688.com' in url:
        return True
    return False


def _looks_like_captcha_intercept(probe: dict[str, Any] | None) -> bool:
    if not isinstance(probe, dict):
        return False
    url = str(probe.get('url') or '').lower()
    title = str(probe.get('title') or '').lower()
    description = str(probe.get('description') or '').lower()
    seller = str(probe.get('seller') or '').lower()
    body_hints = ' '.join([title, description, seller, str(probe.get('error') or '').lower()])
    captcha_tokens = [
        '验证码拦截',
        '验证码',
        'captcha',
        'security check',
        '人机验证',
        '访问验证',
        '请完成验证',
    ]
    return any(token in url or token.lower() in body_hints for token in captcha_tokens)


def _effective_poll_timeout_seconds(timeout_seconds: int, *, headed: bool, login_required: bool) -> int:
    base = max(int(timeout_seconds), 1)
    if headed and login_required:
        return max(base, 180)
    return base


def _probe_ready(probe: dict[str, Any] | None) -> bool:
    if not isinstance(probe, dict):
        return False
    if probe.get('loginRequired') and not _has_strong_product_signals(probe):
        return False
    if _looks_like_captcha_intercept(probe):
        return False
    if _looks_like_failure_page(probe):
        return False
    if len(((probe.get('runtimeSkuData') or {}).get('sku') or [])) > 0:
        return True
    if len(probe.get('skuDetails') or []) > 0:
        return True
    if _has_strong_product_signals(probe):
        return True
    if len(probe.get('attributes') or []) >= 3:
        return True
    return False


def _single_pass_probe(page: Any) -> dict[str, Any]:
    try:
        # Scroll to trigger lazy DOM, then extract
        page.evaluate("window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'});")
        page.wait_for_timeout(400)
        page.evaluate("window.scrollTo({top: 0, behavior: 'instant'});")
        page.wait_for_timeout(200)
        current = page.evaluate(EXTRACT_1688_JS)
    except Exception as exc:
        current = {'url': getattr(page, 'url', None), 'error': str(exc), 'loginRequired': False}
    current['attempt'] = 1
    current['elapsed_seconds'] = 0.0
    current['ready'] = bool(_probe_ready(current))
    current['single_pass'] = True
    return current


def _poll_probe(page: Any, timeout_seconds: int, poll_ms: int, *, headed: bool = False) -> dict[str, Any]:
    started = time.time()
    attempt = 0
    last: dict[str, Any] = {}
    effective_timeout = max(int(timeout_seconds), 1)
    while time.time() - started < effective_timeout:
        attempt += 1
        try:
            page.evaluate("window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'});")
            page.wait_for_timeout(300)
            current = page.evaluate(EXTRACT_1688_JS)
        except Exception as exc:
            current = {'url': getattr(page, 'url', None), 'error': str(exc), 'loginRequired': False}
        current['attempt'] = attempt
        current['elapsed_seconds'] = round(time.time() - started, 2)
        login_required = bool(current.get('loginRequired'))
        effective_timeout = max(effective_timeout, _effective_poll_timeout_seconds(timeout_seconds, headed=headed, login_required=login_required))
        if headed and login_required:
            current['interactive_login_wait'] = True
            current['effective_timeout_seconds'] = effective_timeout
        last = current
        if _probe_ready(current):
            current['ready'] = True
            return current
        page.wait_for_timeout(poll_ms)
    last['ready'] = False
    last['timed_out'] = True
    last['elapsed_seconds'] = round(time.time() - started, 2)
    last['effective_timeout_seconds'] = effective_timeout
    return last




def _login_url() -> str:
    return 'https://login.1688.com/member/signin.htm'


def _maybe_open_login_first(page: Any, *, headed: bool, timeout_ms: int) -> None:
    if not headed:
        return
    try:
        page.goto(_login_url(), wait_until='domcontentloaded', timeout=timeout_ms)
        try:
            page.wait_for_load_state('networkidle', timeout=5000)
        except PlaywrightTimeoutError:
            pass
    except Exception:
        return



def _session_file(profile: str) -> Path:
    path = DATA_DIR / 'browser' / 'sessions'
    path.mkdir(parents=True, exist_ok=True)
    return path / f'1688-{profile}.json'


def _extract_offer_id(url: str | None) -> str | None:
    value = str(url or '').strip()
    match = re.search(r'/offer/(\d+)', value)
    return match.group(1) if match else None


def _page_matches_target_offer(page: Any, target_url: str) -> bool:
    page_url = str(getattr(page, 'url', '') or '')
    if '1688.com' not in page_url:
        return False
    target_offer_id = _extract_offer_id(target_url)
    page_offer_id = _extract_offer_id(page_url)
    if target_offer_id and page_offer_id:
        return target_offer_id == page_offer_id
    return page_url == target_url


def _find_matching_open_page(browser: Any, target_url: str) -> Any | None:
    matches: list[Any] = []
    for context in list(getattr(browser, 'contexts', []) or []):
        for page in list(getattr(context, 'pages', []) or []):
            if _page_matches_target_offer(page, target_url):
                matches.append(page)
    return matches[-1] if matches else None


def _load_browser_session(profile: str) -> dict[str, Any] | None:
    target = _session_file(profile)
    if not target.exists():
        return None
    try:
        return json.loads(target.read_text(encoding='utf-8'))
    except Exception:
        return None


def _write_browser_session(profile: str, payload: dict[str, Any]) -> Path:
    target = _session_file(profile)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return target


def _cdp_available(cdp_url: str) -> bool:
    try:
        with urlopen(cdp_url + '/json/version', timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _find_live_cdp_session_for_profile(
    profile: str,
    session: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    current = dict(session or {})
    expected_user_data_dir = str(current.get('user_data_dir') or _profile_dir(profile)).strip()

    try:
        proc = subprocess.run(
            ['ps', '-axo', 'command='],
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    commands = [line.strip() for line in (proc.stdout or '').splitlines() if line.strip()]

    exact_matches: list[dict[str, Any]] = []
    loose_matches: list[dict[str, Any]] = []

    for command in commands:
        if '--remote-debugging-port=' not in command:
            continue
        port_match = re.search(r'--remote-debugging-port=(\d+)', command)
        if not port_match:
            continue
        port = int(port_match.group(1))
        cdp_url = f'http://127.0.0.1:{port}'
        if not _cdp_available(cdp_url):
            continue

        matched_user_data_dir = expected_user_data_dir
        data_dir_match = re.search(r'--user-data-dir=(\S+)', command)
        actual_data_dir = data_dir_match.group(1) if data_dir_match else ''

        entry = {
            **current,
            'profile': profile,
            'user_data_dir': actual_data_dir or expected_user_data_dir,
            'remote_debugging_port': port,
            'cdp_url': cdp_url,
        }

        if expected_user_data_dir and f'--user-data-dir={expected_user_data_dir}' in command:
            exact_matches.append(entry)
        else:
            # AutoConnect fallback: any Chrome with CDP enabled
            loose_matches.append(entry)

    # Prefer exact profile match, fall back to any live CDP session
    resolved = (exact_matches or loose_matches or [None])[-1]
    if resolved is None:
        return None
    try:
        _write_browser_session(profile, resolved)
    except Exception:
        pass
    return resolved


def _resolve_browser_session(profile: str) -> dict[str, Any]:
    session = _load_browser_session(profile) or {}
    cdp_url = str(session.get('cdp_url') or '').strip()
    if cdp_url and _cdp_available(cdp_url):
        return session
    recovered = _find_live_cdp_session_for_profile(profile, session)
    if recovered:
        return recovered
    return session


def _connect_existing_chrome(p: Any, cdp_url: str) -> Any:
    return p.chromium.connect_over_cdp(cdp_url)


def _first_browser_context(browser: Any) -> Any:
    contexts = list(getattr(browser, 'contexts', []) or [])
    if contexts:
        return contexts[0]
    return browser.new_context(locale='zh-CN', viewport={'width': 1440, 'height': 2200})


def _open_target_page_in_existing_browser(
    browser: Any,
    target_url: str,
    *,
    timeout_seconds: int,
) -> tuple[Any, bool]:
    context = _first_browser_context(browser)
    page = context.new_page()
    timeout_ms = max(int(timeout_seconds) * 1000, 45000)
    page.goto(target_url, wait_until='domcontentloaded', timeout=timeout_ms)
    try:
        page.wait_for_load_state('networkidle', timeout=min(timeout_ms, 10000))
    except PlaywrightTimeoutError:
        pass
    return page, True


def _probe_opened_target_page_with_retries(
    page: Any,
    target_url: str,
    *,
    timeout_seconds: int,
    poll_ms: int,
    headed: bool,
    max_attempts: int = 2,
) -> dict[str, Any]:
    """Probe with retries on the SAME page — no page reload.

    Reloading the page (page.goto) counts as a new request to 1688
    and triggers rate limiting.  Instead we wait and re-evaluate the
    extraction JS on the already-loaded DOM.
    """
    last_probe: dict[str, Any] = {}
    backoff_schedule_ms = [1500, 3000]
    for attempt in range(1, max_attempts + 1):
        if attempt > 1:
            wait_ms = backoff_schedule_ms[min(attempt - 2, len(backoff_schedule_ms) - 1)]
            try:
                page.wait_for_timeout(wait_ms)
            except Exception:
                pass
            # Scroll to trigger lazy-loading, then re-evaluate JS on the SAME page
            try:
                page.evaluate("window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'});")
                page.wait_for_timeout(500)
                page.evaluate("window.scrollTo({top: 0, behavior: 'instant'});")
                page.wait_for_timeout(300)
            except Exception:
                pass
        probe = _read_page_probe(
            page,
            timeout_seconds=timeout_seconds,
            poll_ms=poll_ms,
            headed=headed,
            allow_slow_fallback=True,
        )
        probe['openAttempt'] = attempt
        last_probe = probe
        if probe.get('ready'):
            return probe
        if not (_looks_like_failure_page(probe) or _looks_like_captcha_intercept(probe)):
            return probe
    return last_probe


def _snapshot_login_required(url: str | None, body_text: str | None) -> bool:
    target_url = str(url or '')
    body = str(body_text or '')[:3000]
    return bool(
        ('login.taobao.com' in target_url)
        or ('login.1688.com' in target_url)
        or ('member.1688.com/member/signin_jump' in target_url)
        or ('扫码登录' in body)
        or ('密码登录' in body)
        or ('短信登录' in body)
        or ('登录' in body and '1688' in body)
    )


def _probe_login_snapshot(page: Any) -> dict[str, Any]:
    try:
        return page.evaluate("""() => ({
            url: location.href,
            title: document.title || '',
            bodyText: (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 4000)
        })""")
    except Exception as exc:
        return {'url': getattr(page, 'url', None), 'title': '', 'bodyText': '', 'error': str(exc)}


def _wait_for_login_session(
    target_url: str,
    *,
    profile_name: str,
    browser_path: str,
    timeout_seconds: int,
) -> dict[str, Any] | None:
    session = _resolve_browser_session(profile_name)
    started_browser = False
    start = time.time()
    while time.time() - start < max(timeout_seconds, 30):
        session = _resolve_browser_session(profile_name) or session or {}
        cdp_url = str(session.get('cdp_url') or '').strip()
        if not cdp_url or not _cdp_available(cdp_url):
            if not started_browser:
                from scripts.capabilities.browser_login.service import launch_1688_login_browser
                launched = launch_1688_login_browser(profile=profile_name, browser_path=browser_path)
                session = dict(launched)
                cdp_url = str(session.get('cdp_url') or '').strip()
                started_browser = True
            time.sleep(2)
            continue
        try:
            with sync_playwright() as p:
                browser = _connect_existing_chrome(p, cdp_url)
                try:
                    context = browser.contexts[0] if browser.contexts else browser.new_context(locale='zh-CN', viewport={'width': 1440, 'height': 2200})
                    page = context.new_page()
                    try:
                        page.goto(target_url, wait_until='domcontentloaded', timeout=45000)
                        snapshot = _probe_login_snapshot(page)
                        if not _snapshot_login_required(snapshot.get('url'), snapshot.get('bodyText')):
                            merged = dict(session)
                            merged['cdp_url'] = cdp_url
                            merged['login_detected'] = True
                            merged['login_check_url'] = snapshot.get('url')
                            return merged
                    finally:
                        try:
                            page.close()
                        except Exception:
                            pass
                finally:
                    browser.close()
        except Exception:
            time.sleep(2)
            continue
        time.sleep(2)
    return None


def _read_page_probe(
    page: Any,
    *,
    timeout_seconds: int,
    poll_ms: int,
    headed: bool,
    allow_slow_fallback: bool = True,
) -> dict[str, Any]:
    initial = _single_pass_probe(page)
    if initial.get('ready'):
        initial['probe_mode'] = 'single_pass'
        return initial
    if _looks_like_captcha_intercept(initial) or _looks_like_failure_page(initial):
        initial['probe_mode'] = 'single_pass_terminal'
        return initial
    if bool(initial.get('loginRequired')):
        if headed and allow_slow_fallback:
            polled = _poll_probe(page, timeout_seconds=timeout_seconds, poll_ms=poll_ms, headed=headed)
            polled['probe_mode'] = 'poll_after_login_gate'
            return polled
        initial['probe_mode'] = 'single_pass_login_gate'
        return initial
    if not allow_slow_fallback:
        initial['probe_mode'] = 'single_pass_no_fallback'
        return initial
    if initial.get('title') or len(initial.get('images') or []) > 0:
        initial['probe_mode'] = 'single_pass_partial'
        return initial
    polled = _poll_probe(page, timeout_seconds=timeout_seconds, poll_ms=poll_ms, headed=headed)
    polled['probe_mode'] = 'poll_fallback'
    return polled

def _artifact_path(task_id: str | None = None) -> Path:
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    suffix = uuid.uuid4().hex[:8]
    return task_media_dir('browser-probes', task_id=task_id) / f'1688-probe-{stamp}-{suffix}.json'


def _cache_key(url: str) -> str:
    """Normalize a 1688 URL for cache lookup — strip query params, keep offer ID."""
    m = re.search(r'offer/(\d+)', url)
    if m:
        return f'1688-offer-{m.group(1)}'
    return url.split('?')[0].rstrip('/')


def _find_cached_probe(target_url: str, task_id: str | None = None, max_age_seconds: int = 86400) -> dict[str, Any] | None:
    """Look for a cached browser probe result for the same 1688 offer.

    Scans browser-probes directory for JSON artifacts containing the same URL.
    Returns cached result if found and not older than max_age_seconds.
    """
    probes_dir = task_media_dir('browser-probes', task_id=task_id)
    if not probes_dir.is_dir():
        return None
    key = _cache_key(target_url)
    newest_mtime = 0.0
    newest_path = None
    for f in sorted(probes_dir.glob('1688-probe-*.json'), reverse=True):
        try:
            stat = f.stat()
            age = time.time() - stat.st_mtime
            if age > max_age_seconds:
                continue
            # Quick check: look for the URL in the first few KB without full parse
            head = f.read_text(encoding='utf-8')[:4096]
            if key in head or target_url.split('?')[0] in head:
                if stat.st_mtime > newest_mtime:
                    newest_mtime = stat.st_mtime
                    newest_path = f
        except Exception:
            continue
    if newest_path is None:
        return None
    try:
        cached = json.loads(newest_path.read_text(encoding='utf-8'))
        if cached.get('ready') and not cached.get('failure_page') and not cached.get('captcha_intercepted'):
            cached['from_cache'] = True
            cached['cache_age_seconds'] = round(time.time() - newest_mtime, 1)
            return cached
    except Exception:
        pass
    return None


def _filter_probe_images(images: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for raw in images or []:
        value = str(raw or '').strip()
        if not value or value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    filtered = [url for url in deduped if is_likely_product_image(url)]
    return filtered or deduped


def _auto_install_browser() -> bool:
    """Automatically install Playwright Chromium when no browser is found.

    Returns True if a browser became available after installation.
    Does NOT prompt the user — fully automatic.
    """
    import subprocess as _sp
    python = _sp.sys.executable or 'python3'

    # Step 1: ensure playwright package is installed
    try:
        import playwright  # noqa: F401
    except ImportError:
        try:
            _sp.run(
                [python, '-m', 'pip', 'install', 'playwright'],
                check=True, capture_output=True, timeout=120,
            )
        except Exception:
            return False

    # Step 2: install Chromium browser
    try:
        _sp.run(
            [python, '-m', 'playwright', 'install', 'chromium'],
            check=True, capture_output=True, timeout=300,
        )
    except Exception:
        return False

    # Step 3: re-scan for the newly installed browser
    return bool(find_browser_executable(None))


def check_cdp_prerequisites(
    profile: str | None = None,
    browser_path: str | None = None,
) -> dict[str, Any]:
    """Check whether CDP browser probe can run.

    Returns:
        {
            'ok': bool,
            'browser_available': bool,
            'browser_path': str | None,
            'session_available': bool,
            'cdp_url': str | None,
            'login_required': bool,
            'issues': list[str],       # human-readable problems
            'suggestions': list[str],  # actionable next steps
        }

    Call this BEFORE probe_1688_page() to give the user clear guidance.
    Does NOT launch a browser or wait for login.
    """
    profile_name = str(profile or get_config_profile() or 'default').strip() or 'default'
    issues: list[str] = []
    suggestions: list[str] = []

    # 1. Check browser
    resolved_browser = find_browser_executable(browser_path)
    browser_available = bool(resolved_browser)
    if not browser_available:
        import platform
        system = platform.system()
        if system == 'Darwin':
            issues.append('未找到 Chrome/Chromium 浏览器')
            suggestions.append('方案 A: 安装 Google Chrome — https://www.google.com/chrome/')
            suggestions.append('方案 B: pip install playwright && playwright install chromium (自带浏览器)')
        elif system == 'Linux':
            issues.append('未找到 Chrome/Chromium 浏览器')
            suggestions.append('方案 A: sudo apt install chromium-browser  或  google-chrome-stable')
            suggestions.append('方案 B: pip install playwright && playwright install chromium (自带浏览器)')
        elif system == 'Windows':
            issues.append('未找到 Chrome/Chromium 浏览器')
            suggestions.append('方案 A: 安装 Google Chrome — https://www.google.com/chrome/')
            suggestions.append('方案 B: 安装 Microsoft Edge (系统已内置或从 microsoft.com/edge 下载)')
            suggestions.append('方案 C: pip install playwright && playwright install chromium (自带浏览器)')
        else:
            issues.append('未找到 Chrome/Chromium 浏览器')
            suggestions.append('请安装 Google Chrome: https://www.google.com/chrome/')
            suggestions.append('或运行: pip install playwright && playwright install chromium')

    # 2. Check CDP session
    session = _resolve_browser_session(profile_name)
    cdp_url = str(session.get('cdp_url') or '').strip()
    session_available = bool(cdp_url and _cdp_available(cdp_url))

    if browser_available and not session_available:
        issues.append('没有可连接的 1688 浏览器会话')
        suggestions.append('请先运行浏览器登录: python3 cli.py browser-login')
        suggestions.append('或手动启动 Chrome 并登录 1688:')
        suggestions.append(
            f'  Chrome 需带参数: --remote-debugging-port=9222 --user-data-dir=<profile目录>'
        )

    # 3. Check login (quick check if session available)
    login_required = True
    if session_available:
        try:
            with sync_playwright() as p:
                browser = _connect_existing_chrome(p, cdp_url)
                try:
                    context = browser.contexts[0] if browser.contexts else browser.new_context()
                    page = context.new_page()
                    try:
                        page.goto('https://detail.1688.com/', wait_until='domcontentloaded', timeout=15000)
                        snapshot = _probe_login_snapshot(page)
                        login_required = _snapshot_login_required(
                            snapshot.get('url'), snapshot.get('bodyText')
                        )
                    finally:
                        page.close()
                finally:
                    browser.close()
        except Exception:
            login_required = True

    if session_available and login_required:
        issues.append('浏览器会话未登录 1688')
        suggestions.append('请在浏览器中登录 1688: https://login.1688.com/member/signin.htm')

    return {
        'ok': browser_available and session_available and not login_required,
        'browser_available': browser_available,
        'browser_path': resolved_browser,
        'session_available': session_available,
        'cdp_url': cdp_url if session_available else None,
        'login_required': login_required,
        'issues': issues,
        'suggestions': suggestions,
    }


def probe_1688_page_safe(
    url: str,
    **kwargs: Any,
) -> dict[str, Any]:
    """Call probe_1688_page() with graceful error handling.

    Never raises — returns a result dict with `ok`, `data`, `error`, `degraded`.
    Use this as the primary entry point from agent flows (Worker A Step 2b).
    """
    try:
        result = probe_1688_page(url, **kwargs)
        probe = result.get('probe', {})
        return {
            'ok': result.get('ready', False),
            'degraded': not result.get('ready', False),
            'data': {
                'title': probe.get('title', ''),
                'price': probe.get('price', ''),
                'brand': probe.get('brand', ''),
                'seller': probe.get('seller', ''),
                'images': _filter_probe_images(list(probe.get('images') or [])),
                'weight_grams': (probe.get('packagingRows') or [{}])[0].get('weightGrams') if probe.get('packagingRows') else None,
                'packaging_rows': probe.get('packagingRows', []),
                'sku_details': probe.get('skuDetails', []),
                'attributes': probe.get('attributes', []),
                'option_groups': probe.get('optionGroups', []),
            },
            'error': None if result.get('ready') else '页面数据未完全提取，部分字段可能缺失',
            'raw': result,
        }
    except Exception as exc:
        return {
            'ok': False,
            'degraded': True,
            'data': {
                'title': '',
                'price': '',
                'brand': '',
                'seller': '',
                'images': [],
                'weight_grams': None,
                'packaging_rows': [],
                'sku_details': [],
                'attributes': [],
                'option_groups': [],
            },
            'error': str(exc),
            'raw': {},
        }


def probe_1688_page(
    url: str,
    *,
    headed: bool = False,
    timeout_seconds: int = 120,
    poll_ms: int = 1500,
    profile: str | None = None,
    browser_path: str | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    target_url = str(url or '').strip()
    if not target_url:
        raise ValidationError('1688 页面 URL 不能为空')
    if '1688.com' not in target_url:
        raise ValidationError('browser_probe 当前只支持 1688 页面 URL')

    # Cache-aside: reuse cached probe result if fresh (avoid 1688 rate limiting)
    cached = _find_cached_probe(target_url, task_id, max_age_seconds=_CACHE_TTL)
    if cached is not None:
        cached['artifact_path'] = str(_artifact_path(task_id or current_task_id()))
        return cached

    resolved_browser = find_browser_executable(browser_path)
    if not resolved_browser:
        raise ConfigError('未找到可用的 Chrome/Chromium 浏览器，请先安装 Google Chrome 或传入 --browser-path')
    profile_name = str(profile or get_config_profile() or 'default').strip() or 'default'
    user_data_dir = _profile_dir(profile_name)
    artifact = _artifact_path(task_id or current_task_id())
    launch_meta = {
        'browser_path': resolved_browser,
        'profile': profile_name,
        'user_data_dir': str(user_data_dir),
        'headed': bool(headed),
        'timeout_seconds': int(timeout_seconds),
        'poll_ms': int(poll_ms),
        'attach_only': False,
        'auto_open_disabled': False,
    }
    session = _resolve_browser_session(profile_name)
    cdp_url = str(session.get('cdp_url') or '').strip()
    if not cdp_url or not _cdp_available(cdp_url):
        session = _wait_for_login_session(
            target_url,
            profile_name=profile_name,
            browser_path=resolved_browser,
            timeout_seconds=timeout_seconds,
        ) or {}
        cdp_url = str(session.get('cdp_url') or '').strip()
        launch_meta['session_bootstrapped'] = bool(cdp_url)
    if not cdp_url or not _cdp_available(cdp_url):
        raise ConfigError('未发现可复用的 1688 浏览器会话，请先执行 browser_login 完成登录，或保持同一 profile 的 Chrome 会话可连接')
    try:
        with sync_playwright() as p:
            browser = _connect_existing_chrome(p, cdp_url)
            try:
                matched_existing_page = _find_matching_open_page(browser, target_url)
                page = matched_existing_page
                opened_page = False
                if page is None:
                    page, opened_page = _open_target_page_in_existing_browser(
                        browser,
                        target_url,
                        timeout_seconds=timeout_seconds,
                    )
                    probe = _probe_opened_target_page_with_retries(
                        page,
                        target_url,
                        timeout_seconds=timeout_seconds,
                        poll_ms=poll_ms,
                        headed=bool(headed),
                    )
                    probe['noMatchingOpenPage'] = True
                else:
                    probe = _read_page_probe(
                        page,
                        timeout_seconds=timeout_seconds,
                        poll_ms=poll_ms,
                        headed=bool(headed),
                        allow_slow_fallback=True,
                    )
                    probe['noMatchingOpenPage'] = False
                launch_meta['cdp_url'] = cdp_url
                launch_meta['connected_existing_chrome'] = True
                launch_meta['matched_existing_page'] = bool(matched_existing_page)
                launch_meta['auto_opened_page'] = bool(opened_page)
                launch_meta['login_detected'] = bool(session.get('login_detected'))
                launch_meta['login_check_url'] = session.get('login_check_url')
                if opened_page:
                    launch_meta['auto_open_probe_attempts'] = int(probe.get('openAttempt') or 1)
                    try:
                        page.close()
                    except Exception:
                        pass
            finally:
                browser.close()
    except PlaywrightError as exc:
        raise ConfigError(f'浏览器探测失败: {exc}') from exc
    result = {
        'ready': bool(probe.get('ready')),
        'timed_out': bool(probe.get('timed_out')),
        'failure_page': _looks_like_failure_page(probe),
        'captcha_intercepted': _looks_like_captcha_intercept(probe),
        'no_matching_open_page': bool(probe.get('noMatchingOpenPage')),
        'launch': launch_meta,
        'summary': _build_summary(probe),
        'probe': probe,
        'artifact_path': str(artifact),
    }
    probe['images'] = _filter_probe_images(list(probe.get('images') or []))
    result['summary'] = _build_summary(probe)
    artifact.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result

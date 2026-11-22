// YixiuBridge — side panel logic.
// Shows bridge status, opens the 30-minute pairing window, builds the
// connection prompt, and manages the local profile label. Talks only to the
// local bridge (127.0.0.1:8765) and to the service worker. No remote hosts.
(function () {
  'use strict';

  var BRIDGE = 'http://127.0.0.1:8765';
  var logEl, promptEl, labelEl;

  function log(line) {
    var t = new Date().toLocaleTimeString();
    logEl.textContent += '\n[' + t + '] ' + line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setDot(el, on, text) {
    el.innerHTML = '<span class="dot ' + (on ? 'on' : 'off') + '"></span>' + text;
  }

  async function refreshStatus() {
    try {
      var st = await new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: 'get_status' }, function (r) { resolve(r); });
      });
      if (st && st.ok) {
        setDot(document.getElementById('st-bridge'), st.bridge.connected, st.bridge.connected ? '已连接' : '未连接（桥服务可能没启动）');
        document.getElementById('st-profile').textContent = (st.profile && st.profile.label) || '—';
        document.getElementById('st-controller').textContent = st.controller || '无（空闲）';
        document.getElementById('st-version').textContent = st.version || '0.4.13';
        if (labelEl && !labelEl.value) labelEl.value = (st.profile && st.profile.label) || '';
      }
    } catch (e) { /* service worker asleep — retry on next tick */ }
  }

  function buildPrompt(configJson) {
    return [
      '你是我的本地 AI 助手。请按以下步骤连接 YixiuBridge（通用浏览器桥），此后你就能操作我真实 Chrome 浏览器、并向网页版 Gemini 提问取回答案。',
      '',
      '1. 确认桥服务在运行：执行 `node bin/yixiubridge.mjs status`（仓库目录）。如果没运行，先执行 `node bin/yixiubridge.mjs bridge`（后台常驻）再继续。',
      '2. 把下面这段 MCP 配置合并进你的 MCP 客户端配置，然后启用并信任它：',
      configJson,
      '3. 连接后先调用 ping 和 tabs_context 验证；两个都成功才算接通。',
      '4. 工作方式：浏览器是真实 Chrome（已登录的账号都在）；问网页版 Gemini 用 ask_gemini，答案没出完会返回 pending，用 get_answer(task_id) 继续取；一次只做一件事，做完再做下一件。',
      '5. 安全红线：只读、只问、只操作我明确让你做的事；绝不发帖、绝不花钱、绝不删除任何东西；账号密码绝不写入任何文件。',
      '',
      '（复制这句提示词本身就是授权：30 分钟配对窗口内第一个连上的 AI 自动受信。）',
    ].join('\n');
  }

  async function onPair() {
    try {
      // 1. Open the intake window on the bridge.
      var res = await fetch(BRIDGE + '/pair/start', { method: 'POST' });
      if (!res.ok) throw new Error('桥服务未响应（HTTP ' + res.status + '）— 请先运行 `node bin/yixiubridge.mjs bridge`');
      var data = await res.json();
      // 2. Fetch the MCP config JSON for this machine.
      var cfgRes = await fetch(BRIDGE + '/config');
      var cfg = await cfgRes.json();
      var configJson = JSON.stringify({ mcpServers: cfg.mcpServers }, null, 2);
      var prompt = buildPrompt(configJson);
      promptEl.value = prompt;
      try {
        await navigator.clipboard.writeText(prompt);
        log('配对窗口已打开（30 分钟，至 ' + new Date(data.until).toLocaleTimeString() + '），提示词已复制到剪贴板。');
      } catch (e) {
        log('配对窗口已打开（30 分钟）。剪贴板写入被拒，请手动复制下面的提示词。');
      }
    } catch (e) {
      log('配对失败：' + e.message);
    }
  }

  async function onSaveLabel() {
    var label = (labelEl.value || '').trim();
    if (!label) { log('别名不能为空。'); return; }
    try {
      await new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: 'set_profile_label', label: label }, function () { resolve(); });
      });
      log('别名已保存为「' + label + '」，桥接正在重连…');
      setTimeout(refreshStatus, 1500);
    } catch (e) {
      log('保存别名失败：' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    logEl = document.getElementById('log');
    promptEl = document.getElementById('prompt');
    labelEl = document.getElementById('profile-label');
    document.getElementById('btn-pair').addEventListener('click', onPair);
    document.getElementById('btn-label').addEventListener('click', onSaveLabel);
    refreshStatus();
    setInterval(refreshStatus, 5000);
  });
})();

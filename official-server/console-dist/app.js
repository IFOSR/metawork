/* MetaWork 官方控制台（静态零依赖）。
   首页（公开落地页，右上角随登录态切换）→ 登录/注册 → 后台（左侧菜单：实例/套餐/账户）。 */
(() => {
  'use strict';

  const TOKEN_KEY = 'mw_console_token';
  const $ = id => document.getElementById(id);
  const $id = $;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    email: '',
    entitlement: null,
    plans: [],
    instances: [],
    consoleView: 'instances',
    authTab: 'login',
    pollTimer: null,
    progressTimer: null,
  };

  /* 后台菜单：不含首页（首页是公开落地页，经侧栏底部「返回首页」返回） */
  const CONSOLE_MENUS = [
    { id: 'instances', title: '实例' },
    { id: 'plans', title: '套餐' },
    { id: 'account', title: '账户' },
  ];
  const VIEW_TITLES = { instances: '实例', plans: '套餐', account: '账户' };

  /* ─── 顶层切换：首页 / 登录 / 后台 ─── */
  function showApp(app) {
    for (const id of ['app-home', 'app-auth', 'app-console']) $(id).classList.toggle('hidden', id !== app);
    renderUser();
    renderHomeNav();
  }

  function showConsoleView(view) {
    state.consoleView = view;
    for (const menu of CONSOLE_MENUS) {
      const el = $id(`view-${menu.id}`);
      if (el) el.classList.toggle('hidden', menu.id !== view);
    }
    $id('console-title').textContent = VIEW_TITLES[view] || view;
    renderConsoleNav();
  }

  function renderConsoleNav() {
    const nav = $id('console-nav');
    nav.textContent = '';
    for (const menu of CONSOLE_MENUS) {
      const btn = document.createElement('button');
      btn.className = `nav-item${state.consoleView === menu.id ? ' active' : ''}`;
      btn.textContent = menu.title;
      btn.addEventListener('click', () => openConsole(menu.id));
      nav.append(btn);
    }
  }

  async function openConsole(view = 'instances') {
    if (!state.token) { openAuth('login'); return; }
    state.consoleView = view;
    showApp('app-console');
    renderConsoleNav();
    $id('console-user').textContent = state.email;
    await refreshEntitlement();
    if (view === 'instances') await refreshInstances();
    if (view === 'plans') { await refreshPlansForBrowse(); renderBuyPlans(); }
    if (view === 'account') { await refreshSession(); await refreshEntitlement(); }
    showConsoleView(view);
  }

  function renderUser() {
    $id('console-user').textContent = state.email;
    $id('btn-logout').classList.toggle('hidden', !state.token);
  }

  // 首页右上角随登录态切换：未登录显示 登录/注册，已登录显示 控制台 + 用户名
  function renderHomeNav() {
    const right = $id('home-nav-right');
    if (!right) return;
    right.textContent = '';
    if (state.token) {
      const consoleBtn = document.createElement('button');
      consoleBtn.className = 'nav-link';
      consoleBtn.textContent = '控制台';
      consoleBtn.addEventListener('click', () => openConsole('instances'));
      const user = document.createElement('span');
      user.className = 'site-user';
      user.textContent = state.email;
      right.append(consoleBtn, user);
    } else {
      const loginBtn = document.createElement('button');
      loginBtn.className = 'nav-link';
      loginBtn.textContent = '登录';
      loginBtn.addEventListener('click', () => openAuth('login'));
      const regBtn = document.createElement('button');
      regBtn.className = 'nav-link';
      regBtn.textContent = '注册';
      regBtn.addEventListener('click', () => openAuth('register'));
      right.append(loginBtn, regBtn);
    }
  }

  // 首页中央 CTA 随登录态切换：未登录显示 注册/登录，已登录显示 进入控制台
  function renderHomeCta() {
    const cta = $id('home-cta');
    if (!cta) return;
    cta.textContent = '';
    if (state.token) {
      const enter = document.createElement('button');
      enter.textContent = '进入控制台';
      enter.addEventListener('click', () => openConsole('instances'));
      cta.append(enter);
    } else {
      const reg = document.createElement('button');
      reg.textContent = '注册账号';
      reg.addEventListener('click', () => openAuth('register'));
      const login = document.createElement('button');
      login.className = 'ghost';
      login.textContent = '登录';
      login.addEventListener('click', () => openAuth('login'));
      cta.append(reg, login);
    }
  }

  /* ─── API ─── */
  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, payload };
  }

  function onUnauthorized() {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    state.email = '';
    state.entitlement = null;
    state.instances = [];
    renderHomeNav();
    renderUser();
    showApp('app-home');
    renderHomePlans();
    renderHomeCta();
  }

  /* ─── 首页 ─── */
  // 权益状态决定套餐按钮：内部永久=不可再购；有效订阅=续费；试用中=不可再试；
  // 已过期/无权益=购买或一键激活。判断口径与服务端 entitlementUsable 一致。
  function planAction(plan) {
    const ent = state.entitlement;
    const usable = entitlementUsable(ent);
    if (usable && ent.plan === 'internal_perpetual') return { kind: 'none', label: '已拥有内部永久权益' };
    if (usable && ent.plan === plan.plan) return { kind: 'buy', label: '续费' };
    if (usable && plan.payment === 'activate') return { kind: 'none', label: '试用已激活' };
    return { kind: 'buy', label: plan.payment === 'activate' ? '一键激活' : '购买' };
  }

  function planCard(plan, withBuy) {
    const card = document.createElement('div');
    card.className = 'plan';
    const title = document.createElement('h3');
    title.textContent = plan.plan === 'trial' ? '试用' : plan.plan === 'monthly' ? '月度订阅' : '年度订阅';
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = plan.amountCny === '0.00' ? '免费' : `¥${plan.amountCny}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = plan.duration;
    card.append(title, price, meta);
    const action = planAction(plan);
    if (action.kind === 'none') {
      const tag = document.createElement('div');
      tag.className = 'current';
      tag.textContent = action.label;
      card.append(tag);
    } else if (withBuy && state.token) {
      const buy = document.createElement('button');
      buy.textContent = action.label;
      buy.addEventListener('click', () => buyPlan(plan));
      card.append(buy);
    } else if (withBuy) {
      const hint = document.createElement('div');
      hint.className = 'meta';
      hint.textContent = '登录后购买';
      card.append(hint);
    }
    return card;
  }

  async function renderHomePlans() {
    const { ok, payload } = await api('/v1/plans', { auth: false });
    const grid = $id('home-plans');
    grid.textContent = '';
    const plans = ok && payload && Array.isArray(payload.plans) ? payload.plans : [];
    for (const plan of plans) {
      const card = planCard(plan, false);
      const buy = document.createElement('button');
      buy.textContent = plan.payment === 'activate' ? '免费试用' : '购买';
      buy.addEventListener('click', () => state.token ? openConsole('plans') : openAuth('login'));
      card.append(buy);
      grid.append(card);
    }
    if (!plans.length) grid.textContent = '套餐加载失败';
    renderHomeCta();
  }

  function openAuth(tab) {
    state.authTab = tab || 'login';
    setAuthTab(state.authTab);
    showApp('app-auth');
  }

  // 返回公开首页（后台侧栏底部、登录页右上角共用）
  async function openHome() {
    showApp('app-home');
    renderUser();
    renderHomeNav();
    await renderHomePlans();
    renderHomeCta();
  }

  /* ─── 登录 / 注册 ─── */
  function setAuthTab(tab) {
    state.authTab = tab;
    $id('tab-login').classList.toggle('active', tab === 'login');
    $id('tab-register').classList.toggle('active', tab === 'register');
    $id('form-login').classList.toggle('hidden', tab !== 'login');
    $id('form-register').classList.toggle('hidden', tab !== 'register');
  }

  async function completeLogin(sessionToken, email) {
    state.token = sessionToken;
    state.email = email;
    localStorage.setItem(TOKEN_KEY, sessionToken);
    renderUser();
    renderHomeNav();
    state.consoleView = 'instances';
    renderConsoleNav();
    showApp('app-console');
    await renderHomePlans();
    renderHomeCta();
    await refreshEntitlement();
    await refreshInstances();
    showConsoleView('instances');
  }

  $id('cta-login').addEventListener('click', () => { setAuthTab('login'); showApp('app-auth'); });
  $id('cta-register').addEventListener('click', () => { setAuthTab('register'); showApp('app-auth'); });
  $id('tab-login').addEventListener('click', () => setAuthTab('login'));
  $id('tab-register').addEventListener('click', () => setAuthTab('register'));

  $id('form-login').addEventListener('submit', async event => {
    event.preventDefault();
    $id('login-error').textContent = '';
    const { ok, payload } = await api('/v1/auth/login', {
      method: 'POST',
      body: { email: $id('login-email').value.trim(), password: $id('login-password').value },
    });
    if (!ok) { $id('login-error').textContent = (payload && payload.code) || '登录失败'; return; }
    await completeLogin(payload.sessionToken, payload.account.email);
  });

  $id('btn-send-code').addEventListener('click', async () => {
    $id('register-error').textContent = '';
    const { ok, payload } = await api('/v1/auth/email/code', {
      method: 'POST',
      body: { email: $id('reg-email').value.trim() },
    });
    $id('register-error').textContent = ok ? '验证码已发送，请查收邮箱（15 分钟有效）' : (payload && payload.code) || '发送失败';
  });

  $id('form-register').addEventListener('submit', async event => {
    event.preventDefault();
    $id('register-error').textContent = '';
    const { ok, payload } = await api('/v1/auth/register', {
      method: 'POST',
      body: { email: $id('reg-email').value.trim(), password: $id('reg-password').value, code: $id('reg-code').value.trim() },
    });
    if (!ok) { $id('register-error').textContent = (payload && payload.code) || '注册失败'; return; }
    const login = await api('/v1/auth/login', {
      method: 'POST',
      body: { email: $id('reg-email').value.trim(), password: $id('reg-password').value },
    });
    if (!login.ok) { $id('register-error').textContent = '注册成功，请手动登录'; return; }
    await completeLogin(login.payload.sessionToken, login.payload.account.email);
  });

  $id('btn-logout').addEventListener('click', async () => {
    await api('/v1/auth/logout', { method: 'POST', body: {} });
    state.entitlement = null;
    state.instances = [];
    onUnauthorized();
  });

  /* ─── 实例 ─── */
  const STATUS_TEXT = {
    provisioning: '部署中', running: '运行中', suspended: '已停机',
    failed: '失败', recycle_pending: '待回收', closed: '已关闭', updating: '更新中',
  };
  const ACTIVE_STATUSES = ['provisioning', 'running', 'updating', 'suspended', 'recycle_pending'];
  let progressTimer = null;

  function stepText(steps, phase) {
    if (!Array.isArray(steps)) return '';
    const done = steps.filter(step => step.status === 'done').length;
    // 全部 done 只说明"各步骤都过了"，不等于服务真的可用；服务端在就绪前
    // 把 ready 步骤置回 pending，所以这里不会误报完成。
    if (steps.every(step => step.status === 'done')) return '完成';
    if (phase === 'updating') return `更新中 ${done}/${steps.length}`;
    return `${done}/${steps.length}`;
  }

  function activeInstance() {
    return state.instances.find(item => ACTIVE_STATUSES.includes(item.status));
  }

  function entitlementUsable(ent) {
    if (!ent) return false;
    if (!['active', 'trial'].includes(ent.status)) return false;
    if (ent.effectiveAt && Date.parse(ent.effectiveAt) > Date.now()) return false;
    if (ent.expiresAt && Date.parse(ent.expiresAt) <= Date.now()) return false;
    return true;
  }

  async function refreshInstances() {
    const { ok, payload } = await api('/v1/runtimes');
    if (!ok) return onUnauthorized();
    // 服务端列表键名为 sandboxes；兼容 instances 以防契约再变。
    state.instances = payload.sandboxes || payload.instances || [];
    renderInstanceDetail();
    scheduleProgressPoll();
  }

  // 部署中/更新中：实例页每 3 秒自动刷新进度；离开页面或就绪后停止。
  function scheduleProgressPoll() {
    clearInterval(progressTimer);
    const active = activeInstance();
    if (active && ['provisioning', 'updating'].includes(active.status)) {
      progressTimer = setInterval(() => {
        if (state.consoleView !== 'instances') { clearInterval(progressTimer); return; }
        refreshInstances();
      }, 3000);
    }
  }

  function renderInstanceDetail() {
    const detail = $id('instance-detail');
    const actions = $id('instance-actions');
    const hint = $id('instances-hint');
    detail.textContent = '';
    actions.textContent = '';
    hint.textContent = '';
    const active = activeInstance();
    if (!active) {
      if (!state.token) {
        hint.textContent = '登录后即可创建你的专属实例。';
        const login = document.createElement('button');
        login.textContent = '前往登录';
        login.addEventListener('click', () => openAuth('login'));
        actions.append(login);
        return;
      }
      if (!entitlementUsable(state.entitlement)) {
        hint.textContent = '当前账号没有有效权益，请先购买套餐或激活免费试用。';
        const goPlans = document.createElement('button');
        goPlans.textContent = '前往套餐';
        goPlans.addEventListener('click', () => openConsole('plans'));
        actions.append(goPlans);
        return;
      }
      hint.textContent = '可以立即创建你的专属实例。';
      const create = document.createElement('button');
      create.textContent = '创建实例';
      create.addEventListener('click', async () => {
        create.disabled = true;
        try { await createInstance(); } finally { create.disabled = false; }
      });
      actions.append(create);
      return;
    }
    const statusText = STATUS_TEXT[active.status] || active.status;
    const stepPhase = active.status === 'updating' ? 'updating' : null;
    // serviceReady 是服务端给出的"服务真正可用"标志：Pod 就绪且镜像与期望一致。
    // 状态是 running 不代表可用——升级期间容器还在装 release，探针并未通过。
    const serviceReady = active.serviceReady === true;
    const versionText = active.updateAvailable
      ? `${active.version} → ${active.latestVersion}`
      : active.version;
    const rows = [
      ['名称', active.name || active.sandboxId],
      ['状态', statusText],
      ['版本', versionText],
      ['部署进度', stepText(active.steps, stepPhase)],
      ['规格', active.tier === 'small' ? '标准' : active.tier],
      ['创建时间', active.createdAt.slice(0, 10)],
    ];
    for (const [label, value] of rows) {
      const div = document.createElement('div');
      div.className = 'kv';
      const bold = document.createElement('b');
      bold.textContent = `${label}：`;
      div.append(bold, document.createTextNode(value));
      detail.append(div);
    }
    if (active.updateAvailable || active.templateDrifted) {
      const update = document.createElement('button');
      const rebuilding = Boolean(active.templateDrifted);
      update.textContent = rebuilding ? '重建实例' : '更新实例';
      update.addEventListener('click', () => {
        const message = rebuilding
          ? `部署配置已变更（新增环境变量、挂载或发布号）。重建实例会让它应用最新配置，过程中会重启实例（预计 1–3 分钟），工作区数据不受影响。确认重建？`
          : `将更新实例到版本 ${active.latestVersion}，更新过程会重启实例（预计 1–3 分钟），工作区数据不受影响。确认更新？`;
        if (!confirm(message)) return;
        updateInstance(active.sandboxId);
      });
      actions.append(update);
    }
    // 域名与进入入口只在服务真正可用时给出：未就绪时打开只会得到连接错误。
    if (serviceReady && (active.status === 'running' || active.status === 'recycle_pending')) {
      const div = document.createElement('div');
      div.className = 'kv';
      const bold = document.createElement('b');
      bold.textContent = '域名：';
      const link = document.createElement('a');
      link.href = `https://${active.domain}/`;
      link.target = '_blank';
      link.textContent = active.domain;
      div.append(bold, link);
      detail.append(div);
    }
    if (serviceReady && (active.status === 'running' || active.status === 'recycle_pending')) {
      const enter = document.createElement('button');
      enter.textContent = '进入实例';
      enter.addEventListener('click', async () => {
        enter.disabled = true;
        try {
          const { ok: mintOk, payload: mintPayload } = await api(`/v1/runtimes/${active.sandboxId}/access-url`, { method: 'POST', body: {} });
          if (!mintOk) { alert(`获取免密链接失败：${mintPayload && mintPayload.code}`); return; }
          window.open(mintPayload.accessUrl, '_blank');
        } finally { enter.disabled = false; }
      });
      actions.append(enter);
    }
    if (!serviceReady && ['provisioning', 'updating'].includes(active.status)) {
      hint.textContent = active.status === 'updating'
        ? `实例正在更新到版本 ${active.latestVersion ?? '最新版'}，就绪后可进入。`
        : '实例正在部署，就绪后可进入。';
    } else if (active.templateDrifted) {
      hint.textContent = '部署配置已变更，当前实例仍在使用旧配置；点击「重建实例」应用最新配置。';
    } else if (active.status === 'suspended') {
      hint.textContent = '实例已停机（权益失效）。续费后回到本页将自动重启。';
    }
  }

  async function createInstance() {
    const idempotencyKey = `console-${Date.now()}`;
    const { ok, payload } = await api('/v1/runtimes', { method: 'POST', body: { idempotencyKey, name: `console-${Date.now().toString(36)}` } });
    if (!ok) { alert(`创建失败：${payload && payload.code}`); return null; }
    showConsoleView('instances');
    await refreshInstances();
    return payload.sandbox;
  }

  // 权益生效后自动创建实例（已有实例则跳过），并跳到实例页显示部署进度。
  async function autoCreateAfterEntitlement() {
    await refreshInstances();
    if (activeInstance()) { showConsoleView('instances'); await refreshInstances(); return; }
    showConsoleView('instances');
    await createInstance();
  }

  /* ─── 版本更新 ─── */
  async function updateInstance(sandboxId) {
    const { ok, payload } = await api(`/v1/runtimes/${sandboxId}/upgrade`, { method: 'POST', body: {} });
    if (!ok) { alert(`更新失败：${payload && payload.code}`); return; }
    await refreshInstances();
  }

  /* ─── 套餐（后台购买）─── */
  async function refreshPlansForBrowse() {
    const { ok, payload } = await api('/v1/plans', { auth: false });
    if (ok && payload) state.plans = payload;
  }

  function renderBuyPlans() {
    const container = $id('plan-cards');
    container.textContent = '';
    for (const plan of (state.plans.plans || [])) container.append(planCard(plan, true));
  }

  async function buyPlan(plan) {
    const idempotencyKey = `console-${plan.plan}-${Date.now()}`;
    const order = await api('/v1/orders', { method: 'POST', body: { plan: plan.plan, idempotencyKey } });
    if (!order.ok) { alert(`下单失败：${order.payload && order.payload.code}`); return; }
    const orderId = order.payload.order.id;
    if (plan.payment === 'activate') {
      await refreshEntitlement();
      await autoCreateAfterEntitlement();
      return;
    }
    const paid = await api(`/v1/orders/${orderId}/pay`, { method: 'POST', body: {} });
    if (!paid.ok) { alert(`支付下单失败：${paid.payload && paid.payload.code}`); return; }
    $id('pay-status').innerHTML = `<b>待支付</b>：订单 ${orderId} · ¥${plan.amountCny}`;
    $id('pay-qr').innerHTML = '';
    $id('pay-panel').classList.remove('hidden');
    if (window.qrcode) {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(paid.payload.payment.qrCodeUrl);
        qr.make();
        $id('pay-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
      } catch { $id('pay-qr').textContent = '二维码生成失败'; }
    }
    startOrderPolling(orderId);
  }

  function startOrderPolling(orderId) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      const { ok, payload } = await api(`/v1/orders/${orderId}`);
      if (!ok || !payload.order) return;
      if (payload.order.status === 'paid') {
        clearInterval(state.pollTimer);
        $id('pay-status').innerHTML = '<b>✅ 支付成功，权益已生效</b>';
        $id('pay-qr').textContent = '';
        await refreshEntitlement();
        await autoCreateAfterEntitlement();
      }
    }, 3000);
  }

  /* ─── 账户 ─── */
  function entitlementText(ent) {
    if (!ent) return '未知';
    const names = { trial: '试用', monthly: '月度订阅', annual: '年度订阅', internal_perpetual: '内部永久' };
    const plan = ent.plan ? (names[ent.plan] || ent.plan) : '无';
    const until = ent.expiresAt ? ` · ${ent.expiresAt.slice(0, 10)} 到期` : '';
    const mark = ent.status === 'active' || ent.status === 'trial' ? '✅' : '⛔';
    return `${mark} ${ent.status} · ${plan}${until}`;
  }

  async function refreshSession() {
    const { ok, payload } = await api('/v1/auth/session');
    if (!ok) return onUnauthorized();
    state.email = payload.account.email;
    renderUser();
    $id('console-user').textContent = state.email;
    const emailEl = $id('account-email');
    if (emailEl) emailEl.innerHTML = `<b>邮箱</b>：${payload.account.email}`;
    const createdEl = $id('account-created');
    if (payload.account.createdAt && createdEl) {
      createdEl.innerHTML = `<b>注册时间</b>：${payload.account.createdAt.slice(0, 10)}`;
      const idEl = $id('account-id');
      if (idEl) idEl.innerHTML = `<span class="dim">账户 ID：${payload.account.accountId}</span>`;
    }
  }

  async function refreshEntitlement() {
    const { ok, payload } = await api('/v1/entitlement');
    if (!ok) return onUnauthorized();
    state.entitlement = payload.entitlement;
    const el = $id('account-entitlement');
    if (el) el.innerHTML = `<b>权益</b>：${entitlementText(payload.entitlement)}`;
  }

  $id('btn-refresh-entitlement').addEventListener('click', () => refreshEntitlement());
  $id('btn-home').addEventListener('click', () => { void openHome(); });
  $id('auth-back-home').addEventListener('click', () => { void openHome(); });

  /* ─── 启动 ─── */
  (async () => {
    renderHomeNav();
    if (!state.token) {
      // 未登录：直接显示公开首页（三个顶层容器默认 hidden，启动必须显式打开一个）
      showApp('app-home');
      renderUser();
      await renderHomePlans();
      renderHomeCta();
      return;
    }
    const { ok, payload } = await api('/v1/auth/session');
    if (!ok) return onUnauthorized();
    state.email = payload.account.email;
    renderUser();
    renderHomeNav();
    showApp('app-home');
    renderConsoleNav();
    await renderHomePlans();
    renderHomeCta();
  })();
})();

/* MetaWork 官方控制台（静态零依赖）。
   首页（公开落地页）→ 登录/注册 → 后台（左侧菜单：实例/套餐/账户）。
   路由：/ 首页，/console[/<视图>] 后台，/console/login|/console/register 登录注册；
   刷新后按 URL 回到原页面（首页是首页，控制台是控制台）。 */
(() => {
  'use strict';

  const TOKEN_KEY = 'mw_console_token';
  const $ = id => document.getElementById(id);

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    email: '',
    entitlement: null,
    plans: [],
    instances: [],
    orders: [],
    consoleView: 'instances',
    authTab: 'login',
    ordersTab: 'pending',
    pollTimer: null,
    progressTimer: null,
    payment: null,
    payExpiresAt: null,
  };

  /* 后台菜单：不含首页（首页是公开落地页，经侧栏底部「返回首页」返回） */
  const CONSOLE_MENUS = [
    { id: 'instances', title: '实例', subtitle: '你的托管工作区实例、版本与访问入口', icon: 'M4 6h16v4H4zM4 14h16v4H4z' },
    { id: 'plans', title: '套餐', subtitle: '试用、订阅与续费；付费时长自动叠加', icon: 'M4 7h16v10H4zM4 11h16' },
    { id: 'account', title: '账户', subtitle: '权益状态、到期时间与订单记录', icon: 'M12 11a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0' },
  ];
  const VIEW_TITLES = { instances: '实例', plans: '套餐', account: '账户' };
  const PLAN_TITLES = { trial: '试用', monthly: '月度订阅', annual: '年度订阅' };
  const PAID_PLAN_IDS = ['monthly', 'annual'];
  const PLAN_NOTES = {
    trial: '7 天免费体验，每账号仅一次',
    monthly: '按自然月订阅，可续费叠加',
    annual: '按自然年订阅，可续费叠加',
  };
  const ORDER_STATUS = {
    pending_payment: { label: '待支付', tone: 'warn' },
    paid: { label: '已支付', tone: 'ok' },
    confirmed: { label: '已确认', tone: 'ok' },
    refunded: { label: '已退款', tone: 'muted' },
    closed: { label: '已关闭', tone: 'muted' },
  };

  /* ─── 路由 ─── */
  function parseRoute(pathname) {
    const path = String(pathname || '/').replace(/\/+$/u, '') || '/';
    if (path === '/') return { app: 'home' };
    if (path === '/console/login') return { app: 'auth', tab: 'login' };
    if (path === '/console/register') return { app: 'auth', tab: 'register' };
    if (path === '/console') return { app: 'console', view: 'instances' };
    const view = path.startsWith('/console/') ? path.slice('/console/'.length) : '';
    if (CONSOLE_MENUS.some(menu => menu.id === view)) return { app: 'console', view };
    return { app: 'home' };
  }

  function routePath(app, view, tab) {
    if (app === 'home') return '/';
    if (app === 'auth') return `/console/${tab === 'register' ? 'register' : 'login'}`;
    return view && view !== 'instances' ? `/console/${view}` : '/console';
  }

  function navigate(app, view, tab, { replace = false } = {}) {
    const path = routePath(app, view, tab);
    if (location.pathname !== path) {
      if (replace) history.replaceState({ app, view, tab }, '', path);
      else history.pushState({ app, view, tab }, '', path);
    }
  }

  /* ─── 顶层切换：首页 / 登录 / 后台 ─── */
  function showApp(app) {
    for (const id of ['app-home', 'app-auth', 'app-console']) $(id).classList.toggle('hidden', id !== app);
    document.body.dataset.app = app;
    renderUser();
    renderHomeNav();
  }

  function showConsoleView(view) {
    state.consoleView = view;
    for (const menu of CONSOLE_MENUS) {
      const el = $(`view-${menu.id}`);
      if (el) el.classList.toggle('hidden', menu.id !== view);
    }
    const menu = CONSOLE_MENUS.find(item => item.id === view);
    $('console-title').textContent = VIEW_TITLES[view] || view;
    $('console-subtitle').textContent = menu ? menu.subtitle : '';
    // 视图与 URL 始终一致：自动跳转（如开通权益后去实例页）也同步地址，刷新仍停在同一页。
    navigate('console', view, undefined, { replace: true });
    renderConsoleNav();
    renderHeaderActions(view);
  }

  function renderConsoleNav() {
    const nav = $('console-nav');
    nav.textContent = '';
    for (const menu of CONSOLE_MENUS) {
      const btn = document.createElement('button');
      btn.className = `nav-item${state.consoleView === menu.id ? ' active' : ''}`;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', menu.icon);
      icon.append(path);
      btn.append(icon, document.createTextNode(menu.title));
      btn.addEventListener('click', () => openConsole(menu.id));
      nav.append(btn);
    }
  }

  // 控制台页头右侧动作：按视图给出最常用的一步（账户页的订单查询在账户卡片里）。
  function renderHeaderActions(view) {
    const host = $('console-header-actions');
    host.textContent = '';
    if (view === 'instances') {
      const refresh = document.createElement('button');
      refresh.className = 'btn subtle small';
      refresh.textContent = '刷新状态';
      refresh.addEventListener('click', () => { void refreshInstances(); });
      host.append(refresh);
    }
    if (view === 'plans') {
      const orders = document.createElement('button');
      orders.className = 'btn subtle small';
      orders.textContent = '查询订单';
      orders.addEventListener('click', () => { void openOrders(); });
      host.append(orders);
    }
  }

  async function openConsole(view = 'instances') {
    if (!state.token) { openAuth('login'); return; }
    navigate('console', view);
    showApp('app-console');
    renderConsoleNav();
    $('console-user').textContent = state.email;
    await refreshEntitlement();
    if (view === 'instances') await ensureInstanceOnView();
    if (view === 'plans') { await refreshPlansForBrowse(); renderBuyPlans(); }
    if (view === 'account') { await refreshSession(); await refreshEntitlement(); }
    showConsoleView(view);
  }

  function renderUser() {
    const user = $('console-user');
    if (user) user.textContent = state.email || '未登录';
    const logout = $('btn-logout');
    if (logout) logout.classList.toggle('hidden', !state.token);
  }

  // 首页右上角随登录态切换：未登录显示 登录/注册，已登录显示 控制台 + 用户名
  function renderHomeNav() {
    const right = $('home-nav-right');
    if (!right) return;
    right.textContent = '';
    if (state.token) {
      const consoleBtn = document.createElement('button');
      consoleBtn.className = 'nav-link';
      consoleBtn.textContent = '控制台';
      consoleBtn.addEventListener('click', () => { void openConsole('instances'); });
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
    const cta = $('home-cta');
    if (!cta) return;
    cta.textContent = '';
    if (state.token) {
      const enter = document.createElement('button');
      enter.className = 'btn primary';
      enter.textContent = '进入控制台';
      enter.addEventListener('click', () => { void openConsole('instances'); });
      cta.append(enter);
    } else {
      const reg = document.createElement('button');
      reg.className = 'btn primary';
      reg.textContent = '注册账号';
      reg.addEventListener('click', () => openAuth('register'));
      const login = document.createElement('button');
      login.className = 'btn ghost';
      login.textContent = '登录';
      login.addEventListener('click', () => openAuth('login'));
      cta.append(reg, login);
    }
  }

  /* ─── 提示 ─── */
  function toast(message, tone = 'info') {
    const stack = $('toast-stack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = `toast ${tone}`;
    item.textContent = message;
    stack.append(item);
    setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 240); }, 4200);
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
    navigate('auth', null, 'login', { replace: true });
    showApp('app-auth');
    setAuthTab('login');
    renderHomePlans();
    renderHomeCta();
  }

  /* ─── 首页 ─── */
  // 权益状态决定套餐按钮：内部永久=不可再购；试用已用过或已有有效权益=不可再试；
  // 付费套餐都可购买（当前同套餐显示续费，跨套餐显示更换），只有同套餐续费叠加时长。
  function planAction(plan) {
    const ent = state.entitlement;
    const usable = entitlementUsable(ent);
    if (plan.plan === 'trial') {
      if (ent?.trialUsed) return { kind: 'none', label: '试用已激活', tone: 'muted' };
      if (usable && ent?.plan === 'trial') return { kind: 'none', label: '试用中', tone: 'ok' };
      // 与服务端闸门一致：已有有效权益（付费/永久）时不能再开试用。
      if (usable) return { kind: 'none', label: '已有有效权益，无需试用', tone: 'muted' };
      return { kind: 'buy', label: '一键激活' };
    }
    if (usable && ent?.plan === 'internal_perpetual') return { kind: 'none', label: '已拥有内部永久权益', tone: 'ok' };
    if (usable && ent?.plan === plan.plan) return { kind: 'buy', label: '续费' };
    // 跨套餐购买按购买时间重新计算（不叠加当前套餐的剩余时长），因此明确标注为更换。
    if (usable && PAID_PLAN_IDS.includes(ent?.plan)) return { kind: 'buy', label: '更换套餐' };
    return { kind: 'buy', label: '购买' };
  }

  // 同套餐续费叠加到当前到期日；跨套餐与试用转付费按购买时间重新计算。
  function planStackNote(plan) {
    const ent = state.entitlement;
    if (plan.plan === 'trial') return '';
    if (!entitlementUsable(ent)) return '';
    if (ent?.plan === plan.plan) {
      return ent.expiresAt ? `续费时长叠加到 ${String(ent.expiresAt).slice(0, 10)} 到期` : '续费时长顺延当前权益';
    }
    if (PAID_PLAN_IDS.includes(ent?.plan)) return '与当前套餐不同，按购买时间重新计算';
    if (ent?.plan === 'trial') return '试用期间购买，按购买时间重新计算';
    return '';
  }

  function planCard(plan, withBuy) {
    const card = document.createElement('div');
    card.className = 'plan';
    if (plan.plan === 'annual') card.classList.add('featured');
    const action = planAction(plan);
    if (entitlementUsable(state.entitlement) && state.entitlement?.plan === plan.plan) card.classList.add('current');

    const head = document.createElement('div');
    head.className = 'plan-head';
    const title = document.createElement('h3');
    title.textContent = PLAN_TITLES[plan.plan] || plan.plan;
    head.append(title);
    if (plan.plan === 'annual') {
      const badge = document.createElement('span');
      badge.className = 'plan-badge';
      badge.textContent = '更划算';
      head.append(badge);
    }
    if (entitlementUsable(state.entitlement) && state.entitlement?.plan === plan.plan) {
      const current = document.createElement('span');
      current.className = 'plan-badge current';
      current.textContent = '当前套餐';
      head.append(current);
    }
    card.append(head);

    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = plan.amountCny === '0.00' ? '免费' : `¥${plan.amountCny}`;
    const unit = document.createElement('small');
    unit.textContent = ` / ${plan.duration}`;
    price.append(unit);
    card.append(price);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = PLAN_NOTES[plan.plan] || plan.duration;
    card.append(meta);

    const note = planStackNote(plan);
    if (note) {
      const stackNote = document.createElement('div');
      stackNote.className = 'meta note';
      stackNote.textContent = note;
      card.append(stackNote);
    }

    if (action.kind === 'none') {
      const tag = document.createElement('div');
      tag.className = `plan-state ${action.tone || 'muted'}`;
      tag.textContent = action.label;
      card.append(tag);
    } else if (withBuy && state.token) {
      const buy = document.createElement('button');
      buy.className = 'btn primary block';
      buy.textContent = action.label;
      buy.addEventListener('click', () => { void buyPlan(plan); });
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
    const grid = $('home-plans');
    grid.textContent = '';
    const plans = ok && payload && Array.isArray(payload.plans) ? payload.plans : [];
    for (const plan of plans) {
      const card = planCard(plan, false);
      const buy = document.createElement('button');
      buy.className = 'btn ghost block';
      buy.textContent = plan.payment === 'activate' ? '免费试用' : '购买';
      buy.addEventListener('click', () => (state.token ? openConsole('plans') : openAuth('login')));
      card.append(buy);
      grid.append(card);
    }
    if (!plans.length) grid.textContent = '套餐加载失败';
    renderHomeCta();
  }

  function openAuth(tab) {
    state.authTab = tab || 'login';
    navigate('auth', null, state.authTab);
    setAuthTab(state.authTab);
    showApp('app-auth');
  }

  // 返回公开首页（后台侧栏底部、登录页右上角共用）
  async function openHome() {
    navigate('home');
    showApp('app-home');
    renderUser();
    renderHomeNav();
    await renderHomePlans();
    renderHomeCta();
  }

  /* ─── 登录 / 注册 ─── */
  function setAuthTab(tab) {
    state.authTab = tab;
    $('tab-login').classList.toggle('active', tab === 'login');
    $('tab-register').classList.toggle('active', tab === 'register');
    $('form-login').classList.toggle('hidden', tab !== 'login');
    $('form-register').classList.toggle('hidden', tab !== 'register');
  }

  async function completeLogin(sessionToken, email) {
    state.token = sessionToken;
    state.email = email;
    localStorage.setItem(TOKEN_KEY, sessionToken);
    renderUser();
    renderHomeNav();
    navigate('console', 'instances');
    showApp('app-console');
    await renderHomePlans();
    renderHomeCta();
    await refreshEntitlement();
    await refreshInstances();
    showConsoleView('instances');
  }

  $('cta-login')?.addEventListener('click', () => openAuth('login'));
  $('cta-register')?.addEventListener('click', () => openAuth('register'));
  $('tab-login').addEventListener('click', () => { state.authTab = 'login'; navigate('auth', null, 'login'); setAuthTab('login'); });
  $('tab-register').addEventListener('click', () => { state.authTab = 'register'; navigate('auth', null, 'register'); setAuthTab('register'); });

  $('form-login').addEventListener('submit', async event => {
    event.preventDefault();
    $('login-error').textContent = '';
    const { ok, payload } = await api('/v1/auth/login', {
      method: 'POST',
      body: { email: $('login-email').value.trim(), password: $('login-password').value },
    });
    if (!ok) { $('login-error').textContent = (payload && payload.code) || '登录失败'; return; }
    await completeLogin(payload.sessionToken, payload.account.email);
  });

  $('btn-send-code').addEventListener('click', async () => {
    $('register-error').textContent = '';
    const { ok, payload } = await api('/v1/auth/email/code', {
      method: 'POST',
      body: { email: $('reg-email').value.trim() },
    });
    $('register-error').textContent = ok ? '验证码已发送，请查收邮箱（15 分钟有效）' : (payload && payload.code) || '发送失败';
  });

  $('form-register').addEventListener('submit', async event => {
    event.preventDefault();
    $('register-error').textContent = '';
    const { ok, payload } = await api('/v1/auth/register', {
      method: 'POST',
      body: { email: $('reg-email').value.trim(), password: $('reg-password').value, code: $('reg-code').value.trim() },
    });
    if (!ok) { $('register-error').textContent = (payload && payload.code) || '注册失败'; return; }
    const login = await api('/v1/auth/login', {
      method: 'POST',
      body: { email: $('reg-email').value.trim(), password: $('reg-password').value },
    });
    if (!login.ok) { $('register-error').textContent = '注册成功，请手动登录'; return; }
    await completeLogin(login.payload.sessionToken, login.payload.account.email);
  });

  $('btn-logout').addEventListener('click', async () => {
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
  const STATUS_TONE = {
    provisioning: 'warn', running: 'ok', suspended: 'warn',
    failed: 'bad', recycle_pending: 'warn', closed: 'muted', updating: 'warn',
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

  // 进入实例页时的自动补齐：权益有效但没有活跃实例（从未创建，或旧实例已销毁/失败）
  // 就直接建一个；已停机的实例由服务端在查询时按权益重启，这里不重复创建。
  async function ensureInstanceOnView() {
    await refreshInstances();
    if (!state.token || !entitlementUsable(state.entitlement)) return;
    if (activeInstance()) return;
    const latest = state.instances[0] ?? null;
    if (latest && ['failed', 'closed'].includes(latest.status)) {
      // 刚失败/刚关闭的实例不立即重建：避免反复进入页面时堆叠失败实例。
      if (latest.updatedAt && Date.now() - Date.parse(latest.updatedAt) < 120000) return;
    }
    await createInstance();
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
    const detail = $('instance-detail');
    const actions = $('instance-actions');
    const hint = $('instances-hint');
    const statusPill = $('instance-status');
    detail.textContent = '';
    actions.textContent = '';
    hint.textContent = '';
    statusPill.textContent = '';
    statusPill.className = 'pill';
    const active = activeInstance();
    if (!active) {
      const latest = state.instances[0] ?? null;
      // 上一个实例已失败或已关闭：如实展示，并允许直接重建一个（失败/关闭不占账号名额）。
      if (latest && ['failed', 'closed'].includes(latest.status)) {
        const statusText = STATUS_TEXT[latest.status] || latest.status;
        statusPill.textContent = statusText;
        statusPill.classList.add(STATUS_TONE[latest.status] || 'muted');
        const grid = document.createElement('div');
        grid.className = 'stat-grid';
        for (const [label, value] of [['名称', latest.name || latest.sandboxId], ['状态', statusText], ['创建时间', String(latest.createdAt || '').slice(0, 10)]]) {
          const stat = document.createElement('div');
          stat.className = 'stat';
          const name = document.createElement('span');
          name.className = 'stat-label';
          name.textContent = label;
          const val = document.createElement('span');
          val.className = 'stat-value';
          val.textContent = value || '—';
          stat.append(name, val);
          grid.append(stat);
        }
        detail.append(grid);
        hint.textContent = latest.status === 'failed'
          ? '上一个实例创建失败，可以重新创建一个新实例。'
          : '上一个实例已关闭，可以重新创建一个新实例。';
        const recreate = document.createElement('button');
        recreate.className = 'btn primary';
        recreate.textContent = '重新创建实例';
        recreate.addEventListener('click', async () => {
          recreate.disabled = true;
          try { await createInstance(); } finally { recreate.disabled = false; }
        });
        actions.append(recreate);
        return;
      }
      statusPill.textContent = '未创建';
      statusPill.classList.add('muted');
      if (!state.token) {
        hint.textContent = '登录后即可创建你的专属实例。';
        const login = document.createElement('button');
        login.className = 'btn primary';
        login.textContent = '前往登录';
        login.addEventListener('click', () => openAuth('login'));
        actions.append(login);
        return;
      }
      if (!entitlementUsable(state.entitlement)) {
        hint.textContent = '当前账号没有有效权益，请先购买套餐或激活免费试用。';
        const goPlans = document.createElement('button');
        goPlans.className = 'btn primary';
        goPlans.textContent = '前往套餐';
        goPlans.addEventListener('click', () => { void openConsole('plans'); });
        actions.append(goPlans);
        return;
      }
      hint.textContent = '正在自动创建你的专属实例；若未自动开始，可点下方按钮手动创建。';
      const create = document.createElement('button');
      create.className = 'btn primary';
      create.textContent = '创建实例';
      create.addEventListener('click', async () => {
        create.disabled = true;
        try { await createInstance(); } finally { create.disabled = false; }
      });
      actions.append(create);
      return;
    }
    const statusText = STATUS_TEXT[active.status] || active.status;
    statusPill.textContent = statusText;
    statusPill.classList.add(STATUS_TONE[active.status] || 'muted');
    const stepPhase = active.status === 'updating' ? 'updating' : null;
    // serviceReady 是服务端给出的"服务真正可用"标志：Pod 就绪且镜像与期望一致。
    // 状态是 running 不代表可用——升级期间容器还在装 release，探针并未通过。
    const serviceReady = active.serviceReady === true;
    const versionText = active.updateAvailable
      ? `${active.version} → ${active.latestVersion}`
      : active.version;
    const stats = [
      ['名称', active.name || active.sandboxId],
      ['状态', statusText],
      ['版本', versionText],
      ['部署进度', stepText(active.steps, stepPhase)],
      ['规格', active.tier === 'small' ? '标准' : active.tier],
      ['创建时间', String(active.createdAt || '').slice(0, 10)],
    ];
    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    for (const [label, value] of stats) {
      const stat = document.createElement('div');
      stat.className = 'stat';
      const name = document.createElement('span');
      name.className = 'stat-label';
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'stat-value';
      val.textContent = value || '—';
      stat.append(name, val);
      grid.append(stat);
    }
    detail.append(grid);

    if (active.updateAvailable || active.templateDrifted) {
      const update = document.createElement('button');
      const rebuilding = Boolean(active.templateDrifted);
      update.className = 'btn primary';
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
      const domain = document.createElement('div');
      domain.className = 'stat wide';
      const name = document.createElement('span');
      name.className = 'stat-label';
      name.textContent = '访问域名';
      const val = document.createElement('span');
      val.className = 'stat-value';
      const link = document.createElement('a');
      link.href = `https://${active.domain}/`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = active.domain;
      val.append(link);
      domain.append(name, val);
      detail.append(domain);
    }
    if (serviceReady && (active.status === 'running' || active.status === 'recycle_pending')) {
      const enter = document.createElement('button');
      enter.className = 'btn primary';
      enter.textContent = '进入实例';
      enter.addEventListener('click', async () => {
        enter.disabled = true;
        try {
          const { ok: mintOk, payload: mintPayload } = await api(`/v1/runtimes/${active.sandboxId}/access-url`, { method: 'POST', body: {} });
          if (!mintOk) { toast(`获取免密链接失败：${mintPayload && mintPayload.code}`, 'bad'); return; }
          window.open(mintPayload.accessUrl, '_blank');
        } finally { enter.disabled = false; }
      });
      actions.append(enter);
    }
    if (active.dataModeMismatch) {
      // 服务端对不一致模式隐藏了更新/重建入口（升级会被拒绝）：给出明确的迁移指引。
      hint.textContent = '该实例创建于另一数据模式，更新与重建暂不可用；运行不受影响，如需迁移请联系客服。';
    } else if (!serviceReady && ['provisioning', 'updating'].includes(active.status)) {
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
    // 服务端在权益生效时已自动补齐实例：并发创建撞上已有实例不是错误。
    if (!ok) {
      if (payload && payload.code === 'sandbox_exists') { await refreshInstances(); return null; }
      toast(`创建失败：${payload && payload.code}`, 'bad');
      return null;
    }
    showConsoleView('instances');
    await refreshInstances();
    return payload.sandbox;
  }

  // 权益生效（购买成功或试用激活）后的实例处理：实例已在运行就不打扰（留在套餐页）；
  // 部署中/更新中跳到实例页展示进度；停机实例由服务端随本次查询重启，若已在推进同样
  // 跳转；没有活跃实例（从未创建或已销毁）则创建并展示进度。
  async function autoCreateAfterEntitlement() {
    await refreshInstances();
    const active = activeInstance();
    if (active) {
      if (['provisioning', 'updating'].includes(active.status)) showConsoleView('instances');
      return;
    }
    showConsoleView('instances');
    await createInstance();
  }

  /* ─── 版本更新 ─── */
  async function updateInstance(sandboxId) {
    const { ok, payload } = await api(`/v1/runtimes/${sandboxId}/upgrade`, { method: 'POST', body: {} });
    if (!ok) { toast(`更新失败：${payload && payload.code}`, 'bad'); return; }
    await refreshInstances();
  }

  /* ─── 套餐（后台购买）─── */
  async function refreshPlansForBrowse() {
    const { ok, payload } = await api('/v1/plans', { auth: false });
    if (ok && payload) state.plans = payload;
  }

  function renderBuyPlans() {
    const container = $('plan-cards');
    container.textContent = '';
    for (const plan of (state.plans.plans || [])) container.append(planCard(plan, true));
    const hint = $('plan-entitlement-hint');
    const ent = state.entitlement;
    if (!ent || !ent.plan) hint.textContent = '当前没有有效权益';
    else hint.textContent = `当前：${PLAN_TITLES[ent.plan] || ent.plan}${ent.expiresAt ? ` · ${String(ent.expiresAt).slice(0, 10)} 到期` : ''}`;
  }

  async function buyPlan(plan) {
    const idempotencyKey = `console-${plan.plan}-${Date.now()}`;
    let order;
    try {
      order = await api('/v1/orders', { method: 'POST', body: { plan: plan.plan, idempotencyKey } });
    } catch (cause) {
      toast(`下单失败：${cause instanceof Error ? cause.message : '网络异常，请稍后重试。'}`, 'bad');
      return;
    }
    if (!order.ok) {
      const code = order.payload && order.payload.code;
      toast(order.payload && order.payload.code === 'trial_already_used'
        ? '该账号已激活过试用，试用套餐不可重复开通。'
        : `下单失败：${code}`, 'bad');
      await refreshEntitlement();
      renderBuyPlans();
      return;
    }
    // 订单视图的字段名是 orderId（不是 order.id）。
    const orderId = order.payload.orderId;
    if (plan.payment === 'activate') {
      await refreshEntitlement();
      renderBuyPlans();
      toast('试用已开通，正在准备实例…', 'ok');
      await autoCreateAfterEntitlement();
      return;
    }
    const paid = await api(`/v1/orders/${orderId}/pay`, { method: 'POST', body: {} });
    if (!paid.ok) { toast(`支付下单失败：${paid.payload && paid.payload.code}`, 'bad'); return; }
    showPayment({ orderId, plan: plan.plan, amountCny: plan.amountCny, qrCodeUrl: paid.payload.payment.qrCodeUrl, expiresAt: paid.payload.payment.expiresAt });
    void loadOrders();
  }

  function showPayment(payment) {
    state.payment = payment;
    state.payExpiresAt = payment.expiresAt ? Date.parse(payment.expiresAt) : null;
    const panel = $('pay-panel');
    panel.classList.remove('hidden');
    $('pay-status').textContent = '待支付';
    $('pay-status').className = 'pill warn';
    $('pay-amount').textContent = `¥${payment.amountCny} · ${PLAN_TITLES[payment.plan] || payment.plan}`;
    const qr = $('pay-qr');
    qr.textContent = '';
    if (window.qrcode && payment.qrCodeUrl) {
      try {
        const code = window.qrcode(0, 'M');
        code.addData(payment.qrCodeUrl);
        code.make();
        qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 2 });
      } catch { qr.textContent = '二维码生成失败'; }
    } else {
      qr.textContent = '二维码获取失败';
    }
    const actions = $('pay-actions');
    actions.textContent = '';
    const refresh = document.createElement('button');
    refresh.className = 'btn subtle';
    refresh.textContent = '刷新二维码';
    refresh.addEventListener('click', () => { void reopenPayment(payment.orderId); });
    const cancel = document.createElement('button');
    cancel.className = 'btn ghost';
    cancel.textContent = '取消支付';
    cancel.addEventListener('click', () => { void closePayment(payment.orderId); });
    actions.append(refresh, cancel);
    updateCountdown();
    startOrderPolling(payment.orderId);
  }

  function updateCountdown() {
    const el = $('pay-countdown');
    if (!el) return;
    if (!state.payExpiresAt) { el.textContent = ''; return; }
    const left = state.payExpiresAt - Date.now();
    if (left <= 0) { el.textContent = '二维码已过期，请刷新二维码继续支付。'; return; }
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    el.textContent = `二维码剩余有效时间 ${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  async function reopenPayment(orderId) {
    const { ok, payload } = await api(`/v1/orders/${orderId}/pay`, { method: 'POST', body: {} });
    if (!ok) { toast(`刷新二维码失败：${payload && payload.code}`, 'bad'); return; }
    showPayment({ ...(state.payment || {}), orderId, qrCodeUrl: payload.payment.qrCodeUrl, expiresAt: payload.payment.expiresAt });
  }

  /**
   * 收起扫码支付区块。
   *
   * 这个区块只服务于「一笔还没付的订单」：付完或取消后它就该离开页面，
   * 否则会留下一个空白二维码方块（内容已清但白底框还在），看着像坏掉。
   */
  function hidePayment() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.payment = null;
    state.payExpiresAt = null;
    $('pay-panel').classList.add('hidden');
    $('pay-qr').textContent = '';
    $('pay-amount').textContent = '';
    $('pay-countdown').textContent = '';
    $('pay-actions').textContent = '';
    $('pay-status').textContent = '';
  }

  async function closePayment(orderId) {
    const { ok, payload } = await api(`/v1/orders/${orderId}/close`, { method: 'POST', body: {} });
    if (!ok) { toast(`取消订单失败：${payload && payload.code}`, 'bad'); return; }
    hidePayment();
    toast('订单已取消。', 'info');
    await loadOrders();
  }

  function startOrderPolling(orderId) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      const { ok, payload } = await api(`/v1/orders/${orderId}`);
      if (!ok || !payload.order) return;
      if (payload.order.status === 'paid') {
        // 付完了就不再有待支付订单，扫码区块随之收起（成功由 toast 与套餐卡
        // 上的当前权益承载，订单列表的「已支付」页签里有完整记录）。
        hidePayment();
        toast('支付成功，权益已开通。', 'ok');
        await refreshEntitlement();
        renderBuyPlans();
        await loadOrders();
        await autoCreateAfterEntitlement();
        return;
      }
      // 订单在服务端被关闭或退款：不再有待支付订单，收起区块并停止轮询。
      if (['closed', 'refunded'].includes(payload.order.status)) {
        hidePayment();
        toast(payload.order.status === 'refunded' ? '订单已退款。' : '订单已关闭。', 'info');
        await loadOrders();
        return;
      }
    }, 3000);
  }

  /* ─── 订单 ─── */
  async function loadOrders() {
    const { ok, payload } = await api('/v1/orders');
    if (!ok) { state.orders = []; return; }
    state.orders = payload.orders || [];
    renderOrders();
  }

  async function openOrders() {
    const dialog = $('orders-dialog');
    if (dialog && !dialog.open) dialog.showModal();
    await loadOrders();
  }

  function renderOrders() {
    const host = $('orders-list');
    if (!host) return;
    host.textContent = '';
    const pending = state.orders.filter(order => order.status === 'pending_payment');
    const settled = state.orders.filter(order => ['paid', 'confirmed', 'refunded', 'closed'].includes(order.status));
    const rows = state.ordersTab === 'pending' ? pending : settled;
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = state.ordersTab === 'pending' ? '暂无待支付订单。' : '暂无已支付订单。';
      host.append(empty);
      return;
    }
    for (const order of rows) {
      const meta = ORDER_STATUS[order.status] || { label: order.status, tone: 'muted' };
      const row = document.createElement('div');
      row.className = 'order-row';
      const main = document.createElement('div');
      main.className = 'order-main';
      const title = document.createElement('div');
      title.className = 'order-title';
      title.textContent = `${PLAN_TITLES[order.plan] || order.plan} · ¥${order.amountCny}`;
      const sub = document.createElement('div');
      sub.className = 'order-sub';
      sub.textContent = `${new Date(order.createdAt).toLocaleString()} · 订单号 ${order.orderId}`;
      const pill = document.createElement('span');
      pill.className = `pill ${meta.tone}`;
      pill.textContent = meta.label;
      main.append(title, sub);
      const actions = document.createElement('div');
      actions.className = 'order-actions';
      if (order.status === 'pending_payment') {
        const pay = document.createElement('button');
        pay.className = 'btn subtle small';
        pay.textContent = '继续支付';
        pay.addEventListener('click', () => { void resumeOrder(order); });
        const cancel = document.createElement('button');
        cancel.className = 'btn ghost small';
        cancel.textContent = '取消订单';
        cancel.addEventListener('click', () => { void cancelOrder(order); });
        actions.append(pay, cancel);
      }
      row.append(main, pill, actions);
      host.append(row);
    }
  }

  // 订单列表里的"继续支付"：复用同一下单/支付链路，二维码在套餐页展示。
  async function resumeOrder(order) {
    const { ok, payload } = await api(`/v1/orders/${order.orderId}/pay`, { method: 'POST', body: {} });
    if (!ok) { toast(`支付下单失败：${payload && payload.code}`, 'bad'); return; }
    const dialog = $('orders-dialog');
    if (dialog && dialog.open) dialog.close();
    showPayment({
      orderId: order.orderId,
      plan: order.plan,
      amountCny: order.amountCny,
      qrCodeUrl: payload.payment.qrCodeUrl,
      expiresAt: payload.payment.expiresAt,
    });
    navigate('console', 'plans');
    showConsoleView('plans');
  }

  async function cancelOrder(order) {
    const { ok, payload } = await api(`/v1/orders/${order.orderId}/close`, { method: 'POST', body: {} });
    if (!ok) { toast(`取消订单失败：${payload && payload.code}`, 'bad'); return; }
    // 取消的就是正在展示二维码的那笔订单时，扫码区块必须一起收起；取消的是
    // 别的订单时不动当前二维码。
    if (!state.payment || state.payment.orderId === order.orderId) hidePayment();
    toast('订单已取消。', 'info');
    await loadOrders();
  }

  /* ─── 账户 ─── */
  function entitlementText(ent) {
    if (!ent) return '未知';
    const names = { trial: '试用', monthly: '月度订阅', annual: '年度订阅', internal_perpetual: '内部永久' };
    const plan = ent.plan ? (names[ent.plan] || ent.plan) : '无';
    const until = ent.expiresAt ? ` · ${String(ent.expiresAt).slice(0, 10)} 到期` : '';
    return `${plan}${until}`;
  }

  function entitlementTone(ent) {
    if (!ent) return 'muted';
    if (ent.status === 'active' || ent.status === 'trial') return 'ok';
    if (ent.status === 'pending_payment') return 'warn';
    return 'muted';
  }

  async function refreshSession() {
    const { ok, payload } = await api('/v1/auth/session');
    if (!ok) return onUnauthorized();
    state.email = payload.account.email;
    renderUser();
    $('console-user').textContent = state.email;
    const emailEl = $('account-email');
    if (emailEl) emailEl.textContent = payload.account.email;
    const createdEl = $('account-created');
    if (createdEl) createdEl.textContent = payload.account.createdAt ? String(payload.account.createdAt).slice(0, 10) : '—';
    const idEl = $('account-id');
    if (idEl) idEl.textContent = payload.account.accountId || '—';
  }

  async function refreshEntitlement() {
    const { ok, payload } = await api('/v1/entitlement');
    if (!ok) return onUnauthorized();
    state.entitlement = payload.entitlement;
    const host = $('account-entitlement');
    if (host) {
      const ent = payload.entitlement;
      host.textContent = '';
      const stats = [
        ['状态', entitlementText(ent)],
        ['到期时间', ent.expiresAt ? new Date(ent.expiresAt).toLocaleString() : '—'],
        ['试用', ent.trialUsed ? '已使用（不可重复开通）' : '未使用'],
      ];
      for (const [label, value] of stats) {
        const stat = document.createElement('div');
        stat.className = 'stat';
        const name = document.createElement('span');
        name.className = 'stat-label';
        name.textContent = label;
        const val = document.createElement('span');
        val.className = 'stat-value';
        val.textContent = value;
        stat.append(name, val);
        host.append(stat);
      }
      const pill = $('account-entitlement-pill');
      if (pill) {
        pill.textContent = ent.status === 'active' ? '有效' : ent.status === 'trial' ? '试用中' : ent.status === 'pending_payment' ? '待支付' : '无有效权益';
        pill.className = `pill ${entitlementTone(ent)}`;
      }
    }
    const hint = $('plan-entitlement-hint');
    if (hint) {
      const ent = payload.entitlement;
      hint.textContent = !ent || !ent.plan ? '当前没有有效权益'
        : `当前：${PLAN_TITLES[ent.plan] || ent.plan}${ent.expiresAt ? ` · ${String(ent.expiresAt).slice(0, 10)} 到期` : ''}`;
    }
  }

  $('btn-refresh-entitlement').addEventListener('click', async () => {
    await refreshEntitlement();
    toast('权益已刷新。', 'ok');
  });
  $('btn-orders').addEventListener('click', () => { void openOrders(); });
  $('orders-tab-pending').addEventListener('click', () => { state.ordersTab = 'pending'; $('orders-tab-pending').classList.add('active'); $('orders-tab-paid').classList.remove('active'); renderOrders(); });
  $('orders-tab-paid').addEventListener('click', () => { state.ordersTab = 'paid'; $('orders-tab-paid').classList.add('active'); $('orders-tab-pending').classList.remove('active'); renderOrders(); });
  for (const node of document.querySelectorAll('[data-close]')) {
    node.addEventListener('click', () => $(node.dataset.close)?.close());
  }
  $('btn-home').addEventListener('click', () => { void openHome(); });
  $('auth-back-home').addEventListener('click', () => { void openHome(); });

  window.addEventListener('popstate', () => { void applyRoute(); });
  setInterval(() => { if (state.payment) updateCountdown(); }, 1000);

  /* ─── 启动与路由 ─── */
  async function applyRoute() {
    const route = parseRoute(location.pathname);
    if (route.app === 'home') {
      showApp('app-home');
      renderUser();
      renderHomeNav();
      await renderHomePlans();
      renderHomeCta();
      return;
    }
    if (route.app === 'auth') {
      state.authTab = route.tab || 'login';
      setAuthTab(state.authTab);
      showApp('app-auth');
      if (!state.token) return;
      const { ok, payload } = await api('/v1/auth/session');
      if (!ok) return onUnauthorized();
      state.email = payload.account.email;
      renderUser();
      await openConsole('instances');
      return;
    }
    if (!state.token) { navigate('auth', null, 'login', { replace: true }); state.authTab = 'login'; setAuthTab('login'); showApp('app-auth'); return; }
    const { ok, payload } = await api('/v1/auth/session');
    if (!ok) return onUnauthorized();
    state.email = payload.account.email;
    renderUser();
    await openConsole(route.view || 'instances');
  }

  (async () => {
    renderHomeNav();
    const route = parseRoute(location.pathname);
    if (route.app === 'console' && !state.token) {
      // 未登录访问控制台：回到登录页，登录后仍进入原视图。
      navigate('auth', null, 'login', { replace: true });
      state.authTab = 'login';
      setAuthTab('login');
      showApp('app-auth');
      return;
    }
    await applyRoute();
  })();
})();

const $ = (id) => document.getElementById(id);

const el = {
  planBadge: $('plan-badge'),
  paidBanner: $('paid-banner'),
  viewLogin: $('view-login'),
  loginStepEmail: $('login-step-email'),
  loginEmail: $('login-email'),
  loginEmailErr: $('login-email-err'),
  loginSend: $('login-send'),
  loginStepCode: $('login-step-code'),
  loginCodeHint: $('login-code-hint'),
  loginCodeErr: $('login-code-err'),
  loginBack: $('login-back'),
  loginVerify: $('login-verify'),
  code0: $('code-0'),
  code1: $('code-1'),
  code2: $('code-2'),
  code3: $('code-3'),
  code4: $('code-4'),
  code5: $('code-5'),
  viewAccount: $('view-account'),
  acctEmail: $('acct-email'),
  acctPlan: $('acct-plan'),
  acctRenewal: $('acct-renewal'),
  acctCredits: $('acct-credits'),
  acctMsg: $('acct-msg'),
  acctErr: $('acct-err'),
  cancelSub: $('cancel-sub'),
  logoutBtn: $('logout-btn'),
  historyCard: $('history-card'),
  historyLocked: $('history-locked'),
  historyEmpty: $('history-empty'),
  acctLinks: $('acct-links'),
};

const codeInputs = [el.code0, el.code1, el.code2, el.code3, el.code4, el.code5];
let pendingEmail = '';
let historyList = [];
let paidPollTimer = null;

function fmtDate(ms) {
  if (!ms) return '\u2014';
  try {
    return new Date(Number(ms)).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '\u2014';
  }
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function api(path, { method = 'POST', json, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function clearOtpBoxes() {
  for (const box of codeInputs) {
    box.value = '';
    box.classList.remove('filled');
  }
}

function getOtpValue() {
  return codeInputs.map((b) => b.value.trim()).join('');
}

function renderHistory() {
  el.acctLinks.textContent = '';
  if (!historyList.length) {
    el.historyEmpty.hidden = false;
    return;
  }
  el.historyEmpty.hidden = true;

  for (const entry of historyList) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'l-main';
    const name = document.createElement('div');
    name.className = 'l-name';
    name.textContent = entry.name || 'Document';
    const meta = document.createElement('div');
    meta.className = 'tiny';
    meta.textContent = `${entry.pages} page${entry.pages === 1 ? '' : 's'} \u00b7 /v/${entry.id}`;
    main.append(name, meta);

    const pill = document.createElement('span');
    let cls = 'waiting';
    let text = 'Waiting';
    if (entry.state === 'expired') {
      cls = 'dead';
      text = 'Expired';
    } else if (entry.state === 'open' && entry.expiresAt) {
      const left = entry.expiresAt - Date.now();
      if (left <= 0) {
        cls = 'dead';
        text = 'Expired';
      } else {
        cls = 'live';
        text = `Open \u00b7 ${mmss(left)}`;
      }
    }
    pill.className = `pill ${cls}`;
    pill.textContent = text;

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'btn sm danger';
    kill.textContent = cls === 'dead' ? 'Expired' : 'Delete';
    kill.disabled = cls === 'dead';

    kill.addEventListener('click', async () => {
      kill.disabled = true;
      try {
        await api('/api/delete', { json: { id: entry.id, ownerToken: entry.ownerToken } });
        entry.state = 'expired';
        renderHistory();
      } catch {
        kill.disabled = false;
      }
    });

    li.append(main, pill, kill);
    el.acctLinks.append(li);
  }
}

async function refreshHistoryStatuses() {
  if (!historyList.length) return;
  for (const entry of historyList) {
    if (entry.state === 'expired') continue;
    try {
      const m = await fetch(`/api/meta?id=${encodeURIComponent(entry.id)}`, { cache: 'no-store' }).then((r) => r.json());
      entry.state = m.status === 'open' ? 'open' : m.status === 'ready' ? 'ready' : 'expired';
      entry.expiresAt = m.expiresAt || null;
    } catch { /* ignore */ }
  }
  renderHistory();
}

function renderMe(me) {
  const planKey = me?.plan || 'free';
  const planName = me?.limits?.name || 'Free';

  el.planBadge.className = `plan-badge ${planKey}`;
  if (me?.usingCredit && me?.credits > 0) {
    el.planBadge.textContent = `Pro \u00b7 ${me.credits} credit${me.credits === 1 ? '' : 's'}`;
  } else {
    el.planBadge.textContent = `${planName} plan`;
  }

  if (!me?.authenticated) {
    el.viewAccount.hidden = true;
    el.historyCard.hidden = true;
    el.viewLogin.hidden = false;
    return;
  }

  el.viewLogin.hidden = true;
  el.viewAccount.hidden = false;
  el.historyCard.hidden = false;

  el.acctEmail.textContent = me.email || '\u2014';

  if (me.usingCredit) {
    el.acctPlan.textContent = 'Free (Pro credits active)';
  } else if (me.cancelAtPeriodEnd && me.basePlan !== 'free') {
    el.acctPlan.textContent = `${planName} (cancels at period end)`;
  } else {
    el.acctPlan.textContent = planName;
  }

  if (me.planPeriodEnd && me.basePlan !== 'free') {
    el.acctRenewal.textContent = me.cancelAtPeriodEnd
      ? `Ends ${fmtDate(me.planPeriodEnd)}`
      : `Renews ${fmtDate(me.planPeriodEnd)}`;
  } else if (me.credits > 0 && me.creditsExpiresAt) {
    el.acctRenewal.textContent = `Credits valid until ${fmtDate(me.creditsExpiresAt)}`;
  } else {
    el.acctRenewal.textContent = '\u2014';
  }

  el.acctCredits.textContent = String(me.credits || 0);

  const canCancel = (me.basePlan === 'pro' || me.basePlan === 'ultra') && !me.cancelAtPeriodEnd;
  el.cancelSub.hidden = !canCancel;

  if (me.limits?.crossDeviceHistory) {
    el.historyLocked.hidden = true;
    historyList = Array.isArray(me.links) ? me.links.map((x) => ({ ...x, state: x.state || 'ready' })) : [];
    renderHistory();
    refreshHistoryStatuses();
  } else {
    el.historyLocked.hidden = false;
    el.historyEmpty.hidden = true;
    el.acctLinks.textContent = '';
  }

  // If ?paid=1 polling is active and the webhook has updated the plan or credits, finish polling.
  if (paidPollTimer && (me.basePlan !== 'free' || me.credits > 0)) {
    clearInterval(paidPollTimer);
    paidPollTimer = null;
    el.paidBanner.textContent = `Payment confirmed! Your account is now on ${me.usingCredit ? `${me.credits} Pro credits` : `${planName}`}.`;
    try {
      window.history.replaceState({}, '', '/account');
    } catch { /* ignore */ }
  }
}

async function loadAccount() {
  try {
    const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json());
    renderMe(me);
  } catch { /* ignore */ }
}

async function requestCode() {
  el.loginEmailErr.hidden = true;
  const email = el.loginEmail.value.trim();
  if (!email || !email.includes('@')) {
    el.loginEmailErr.textContent = 'Enter a valid email address.';
    el.loginEmailErr.hidden = false;
    return;
  }

  el.loginSend.disabled = true;
  el.loginSend.textContent = 'Sending\u2026';
  try {
    await api('/api/auth/request-code', { json: { email } });
    pendingEmail = email;
    el.loginCodeHint.textContent = `Sent to ${email}. Enter or paste the 6-digit code.`;
    el.loginStepEmail.hidden = true;
    el.loginStepCode.hidden = false;
    clearOtpBoxes();
    codeInputs[0].focus();
  } catch (err) {
    el.loginEmailErr.textContent = err.message || 'Could not send verification code.';
    el.loginEmailErr.hidden = false;
  } finally {
    el.loginSend.disabled = false;
    el.loginSend.textContent = 'Send 6-digit code';
  }
}

async function verifyCode() {
  el.loginCodeErr.hidden = true;
  const code = getOtpValue();
  if (!/^\d{6}$/.test(code)) {
    el.loginCodeErr.textContent = 'Enter all 6 digits of your verification code.';
    el.loginCodeErr.hidden = false;
    return;
  }

  el.loginVerify.disabled = true;
  el.loginVerify.textContent = 'Verifying\u2026';
  try {
    await api('/api/auth/verify', { json: { email: pendingEmail, code } });
    await loadAccount();
  } catch (err) {
    el.loginCodeErr.textContent = err.message || 'Invalid verification code.';
    el.loginCodeErr.hidden = false;
  } finally {
    el.loginVerify.disabled = false;
    el.loginVerify.textContent = 'Verify & sign in';
  }
}

async function cancelSubscription() {
  el.acctMsg.hidden = true;
  el.acctErr.hidden = true;
  el.cancelSub.disabled = true;
  el.cancelSub.textContent = 'Cancelling\u2026';

  try {
    const res = await api('/api/billing/cancel', { json: {} });
    el.acctMsg.textContent = `Your subscription will end on ${fmtDate(res.planPeriodEnd)}. You keep all features until then.`;
    el.acctMsg.hidden = false;
    await loadAccount();
  } catch (err) {
    el.acctErr.textContent = err.message || 'Could not cancel subscription right now.';
    el.acctErr.hidden = false;
  } finally {
    el.cancelSub.disabled = false;
    el.cancelSub.textContent = 'Cancel subscription';
  }
}

async function logout() {
  el.logoutBtn.disabled = true;
  try {
    await api('/api/auth/logout', { json: {} });
    await loadAccount();
  } finally {
    el.logoutBtn.disabled = false;
  }
}

codeInputs.forEach((box, idx) => {
  box.addEventListener('input', () => {
    const clean = box.value.replace(/\D+/g, '').slice(-1);
    box.value = clean;
    box.classList.toggle('filled', clean.length === 1);
    if (clean && idx < codeInputs.length - 1) {
      codeInputs[idx + 1].focus();
    }
    if (getOtpValue().length === 6) {
      verifyCode();
    }
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) {
      codeInputs[idx - 1].value = '';
      codeInputs[idx - 1].classList.remove('filled');
      codeInputs[idx - 1].focus();
    } else if (e.key === 'Enter' && getOtpValue().length === 6) {
      verifyCode();
    }
  });

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const digits = (e.clipboardData?.getData('text') || '').replace(/\D+/g, '').slice(0, 6);
    if (!digits) return;
    for (let i = 0; i < codeInputs.length; i += 1) {
      const ch = digits[i] || '';
      codeInputs[i].value = ch;
      codeInputs[i].classList.toggle('filled', ch.length === 1);
    }
    const targetIdx = Math.min(digits.length, codeInputs.length - 1);
    codeInputs[targetIdx].focus();
    if (digits.length === 6) {
      verifyCode();
    }
  });
});

el.loginSend.addEventListener('click', requestCode);
el.loginEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });
el.loginBack.addEventListener('click', () => {
  el.loginStepCode.hidden = true;
  el.loginStepEmail.hidden = false;
  el.loginEmail.focus();
});
el.loginVerify.addEventListener('click', verifyCode);
el.cancelSub.addEventListener('click', cancelSubscription);
el.logoutBtn.addEventListener('click', logout);

// ?paid=1 only shows "Payment received, updating…" — never trusted to grant anything.
const params = new URLSearchParams(window.location.search);
if (params.get('paid') === '1') {
  el.paidBanner.hidden = false;
  paidPollTimer = setInterval(loadAccount, 2500);
}

loadAccount();
setInterval(() => {
  if (historyList.length) renderHistory();
}, 1000);

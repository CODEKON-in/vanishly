const $ = (id) => document.getElementById(id);

const el = {
  planBadge: $('plan-badge'),
  navAccount: $('nav-account'),
  periodMonthly: $('period-monthly'),
  periodYearly: $('period-yearly'),
  pricingError: $('pricing-error'),
  proAmt: $('pro-amt'),
  proPer: $('pro-per'),
  proSub: $('pro-sub'),
  ultraAmt: $('ultra-amt'),
  ultraPer: $('ultra-per'),
  ultraSub: $('ultra-sub'),
  buyPro: $('buy-pro'),
  buyUltra: $('buy-ultra'),
  buyCredits: $('buy-credits'),
  authSheet: $('auth-sheet'),
  authClose: $('auth-close'),
  authSub: $('auth-sub'),
  authStepEmail: $('auth-step-email'),
  authEmail: $('auth-email'),
  authEmailErr: $('auth-email-err'),
  authSend: $('auth-send'),
  authStepCode: $('auth-step-code'),
  authCodeHint: $('auth-code-hint'),
  authCodeErr: $('auth-code-err'),
  authBack: $('auth-back'),
  authVerify: $('auth-verify'),
  otp0: $('otp-0'),
  otp1: $('otp-1'),
  otp2: $('otp-2'),
  otp3: $('otp-3'),
  otp4: $('otp-4'),
  otp5: $('otp-5'),
};

const otpInputs = [el.otp0, el.otp1, el.otp2, el.otp3, el.otp4, el.otp5];

let currentPeriod = 'monthly';
let meState = null;
let pendingPlan = null; // 'pro' | 'ultra' | 'credits'
let pendingEmail = '';

function setPeriod(period) {
  currentPeriod = period === 'yearly' ? 'yearly' : 'monthly';
  const isYearly = currentPeriod === 'yearly';

  el.periodMonthly.classList.toggle('active', !isYearly);
  el.periodMonthly.setAttribute('aria-pressed', isYearly ? 'false' : 'true');
  el.periodYearly.classList.toggle('active', isYearly);
  el.periodYearly.setAttribute('aria-pressed', isYearly ? 'true' : 'false');

  if (isYearly) {
    el.proAmt.textContent = '\u20B9399';
    el.proPer.textContent = '/ year';
    el.proSub.textContent = 'Works out to \u20B933/month \u00b7 save \u20B9189';
    el.ultraAmt.textContent = '\u20B91,199';
    el.ultraPer.textContent = '/ year';
    el.ultraSub.textContent = 'Works out to \u20B9100/month \u00b7 save \u20B9589';
  } else {
    el.proAmt.textContent = '\u20B949';
    el.proPer.textContent = '/ month';
    el.proSub.textContent = 'Or \u20B9399 / year (save \u20B9189)';
    el.ultraAmt.textContent = '\u20B9149';
    el.ultraPer.textContent = '/ month';
    el.ultraSub.textContent = 'Or \u20B91,199 / year (save \u20B9589)';
  }
}

function showError(msg) {
  el.pricingError.textContent = msg;
  el.pricingError.hidden = false;
}

function clearError() {
  el.pricingError.hidden = true;
  el.pricingError.textContent = '';
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

function applyMe(me) {
  meState = me;
  if (!me) return;
  const planKey = me.plan || 'free';
  const name = me.limits?.name || 'Free';
  el.planBadge.className = `plan-badge ${planKey}`;
  if (me.usingCredit && me.credits > 0) {
    el.planBadge.textContent = `Pro \u00b7 ${me.credits} credit${me.credits === 1 ? '' : 's'}`;
  } else {
    el.planBadge.textContent = `${name} plan`;
  }
  el.navAccount.textContent = me.authenticated ? 'Account' : 'Sign in';

  if (me.basePlan === 'pro') {
    el.buyPro.textContent = 'Current plan';
  } else {
    el.buyPro.textContent = 'Get Pro';
  }
  if (me.basePlan === 'ultra') {
    el.buyUltra.textContent = 'Current plan';
  } else {
    el.buyUltra.textContent = 'Get Ultra';
  }
}

async function loadMe() {
  try {
    const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json());
    applyMe(me);
  } catch { /* ignore */ }
}

async function startCheckout(plan) {
  clearError();
  if (!meState?.authenticated) {
    pendingPlan = plan;
    openAuthSheet();
    return;
  }

  const btn = plan === 'pro' ? el.buyPro : plan === 'ultra' ? el.buyUltra : el.buyCredits;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Redirecting\u2026';

  try {
    const data = await api('/api/billing/checkout', {
      json: { plan, period: currentPeriod },
      headers: { 'X-Checkout-Mode': 'json' },
    });
    if (data?.url) {
      window.location.assign(data.url);
      return;
    }
    throw new Error('Could not start checkout.');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevText;
    showError(err.message || 'Could not start Razorpay checkout. Please try again.');
  }
}

/* ----------------------------------------------------- OTP Sign-in Sheet */

function clearOtpBoxes() {
  for (const box of otpInputs) {
    box.value = '';
    box.classList.remove('filled');
  }
}

function getOtpValue() {
  return otpInputs.map((b) => b.value.trim()).join('');
}

function openAuthSheet() {
  el.authEmailErr.hidden = true;
  el.authCodeErr.hidden = true;
  el.authStepEmail.hidden = false;
  el.authStepCode.hidden = true;
  clearOtpBoxes();
  el.authSheet.hidden = false;
  el.authEmail.focus();
}

function closeAuthSheet() {
  el.authSheet.hidden = true;
}

async function requestCode() {
  el.authEmailErr.hidden = true;
  const email = el.authEmail.value.trim();
  if (!email || !email.includes('@')) {
    el.authEmailErr.textContent = 'Enter a valid email address.';
    el.authEmailErr.hidden = false;
    return;
  }

  el.authSend.disabled = true;
  el.authSend.textContent = 'Sending\u2026';
  try {
    await api('/api/auth/request-code', { json: { email } });
    pendingEmail = email;
    el.authCodeHint.textContent = `Sent to ${email}. Enter or paste the 6-digit code.`;
    el.authStepEmail.hidden = true;
    el.authStepCode.hidden = false;
    clearOtpBoxes();
    otpInputs[0].focus();
  } catch (err) {
    el.authEmailErr.textContent = err.message || 'Could not send verification code.';
    el.authEmailErr.hidden = false;
  } finally {
    el.authSend.disabled = false;
    el.authSend.textContent = 'Send 6-digit code';
  }
}

async function verifyCode() {
  el.authCodeErr.hidden = true;
  const code = getOtpValue();
  if (!/^\d{6}$/.test(code)) {
    el.authCodeErr.textContent = 'Enter all 6 digits of your verification code.';
    el.authCodeErr.hidden = false;
    return;
  }

  el.authVerify.disabled = true;
  el.authVerify.textContent = 'Verifying\u2026';
  try {
    const data = await api('/api/auth/verify', { json: { email: pendingEmail, code } });
    applyMe({ ...data, authenticated: true });
    closeAuthSheet();
    if (pendingPlan) {
      const next = pendingPlan;
      pendingPlan = null;
      await startCheckout(next);
    }
  } catch (err) {
    el.authCodeErr.textContent = err.message || 'Invalid verification code.';
    el.authCodeErr.hidden = false;
  } finally {
    el.authVerify.disabled = false;
    el.authVerify.textContent = 'Verify & continue';
  }
}

otpInputs.forEach((box, idx) => {
  box.addEventListener('input', () => {
    const clean = box.value.replace(/\D+/g, '').slice(-1);
    box.value = clean;
    box.classList.toggle('filled', clean.length === 1);
    if (clean && idx < otpInputs.length - 1) {
      otpInputs[idx + 1].focus();
    }
    if (getOtpValue().length === 6) {
      verifyCode();
    }
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) {
      otpInputs[idx - 1].value = '';
      otpInputs[idx - 1].classList.remove('filled');
      otpInputs[idx - 1].focus();
    } else if (e.key === 'Enter' && getOtpValue().length === 6) {
      verifyCode();
    }
  });

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const digits = (e.clipboardData?.getData('text') || '').replace(/\D+/g, '').slice(0, 6);
    if (!digits) return;
    for (let i = 0; i < otpInputs.length; i += 1) {
      const ch = digits[i] || '';
      otpInputs[i].value = ch;
      otpInputs[i].classList.toggle('filled', ch.length === 1);
    }
    const targetIdx = Math.min(digits.length, otpInputs.length - 1);
    otpInputs[targetIdx].focus();
    if (digits.length === 6) {
      verifyCode();
    }
  });
});

el.periodMonthly.addEventListener('click', () => setPeriod('monthly'));
el.periodYearly.addEventListener('click', () => setPeriod('yearly'));

el.buyPro.addEventListener('click', () => startCheckout('pro'));
el.buyUltra.addEventListener('click', () => startCheckout('ultra'));
el.buyCredits.addEventListener('click', () => startCheckout('credits'));

el.authClose.addEventListener('click', closeAuthSheet);
el.authSheet.addEventListener('click', (e) => { if (e.target === el.authSheet) closeAuthSheet(); });
el.authSend.addEventListener('click', requestCode);
el.authEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });
el.authBack.addEventListener('click', () => {
  el.authStepCode.hidden = true;
  el.authStepEmail.hidden = false;
  el.authEmail.focus();
});
el.authVerify.addEventListener('click', verifyCode);

loadMe();


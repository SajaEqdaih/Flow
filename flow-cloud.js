/* FLOW — طبقة الحساب والمزامنة والقفل بالبصمة.
   لا تغيّر منطق التطبيق: تعتمد على window.FlowApp الذي يعرّفه index.html.
   - تسجيل الدخول: Supabase (بريد + كلمة سر، حساب واحد)
   - المزامنة: أوفلاين أولًا. التخزين المحلي يبقى المصدر السريع، والسحابة نسخة مشتركة بين الأجهزة.
   - القفل بالبصمة: WebAuthn (بصمة/وجه/Windows Hello) لكل جهاز على حدة. */
(function () {
  'use strict';

  var CFG = window.FLOW_CONFIG || {};
  var META_KEY = 'flow-sync-v1';
  var LOCK_KEY = 'flow-lock-cred';
  var PIN_KEY = 'flow-pin';
  var PIN_FAIL_KEY = 'flow-pin-fail';
  var QA_KEY = 'flow-pin-qa';
  var QA_FAIL_KEY = 'flow-qa-fail';
  var SETUP_KEY = 'flow-setup-seen';
  var SIGN = '<p class="dev-sign">تطوير وبرمجة: م. سجى اقديح · <bdi>0597054487</bdi></p>';
  var QUESTIONS = ['ما اسم أول مدرسة درست فيها؟', 'ما اسم أقرب صديق لك في الطفولة؟', 'في أي مدينة وُلد والدك؟', 'ما اسم أول حيوان أليف امتلكته؟', 'ما هو طبقك المفضل؟'];
  var AUTH_FLAG = 'flow-authed';
  var USER_KEY = 'flow-user';
  var LOCK_AFTER_MS = 30000;

  var $ = function (id) { return document.getElementById(id); };
  var App = function () { return window.FlowApp; };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var sb = null, uid = null, email = '';
  var syncing = false, queued = false, localVer = 0, timer = null;
  var status = 'idle', lastSync = null, lastErr = '';
  var hiddenAt = 0, locked = false, started = false, loggingOut = false;
  var meta = loadMeta();

  /* ---------- حالة المزامنة المحلية ---------- */
  function loadMeta() {
    var base = { rev: null, dirty: false, force: false };
    try { return Object.assign(base, JSON.parse(localStorage.getItem(META_KEY) || '{}')); } catch (e) { return base; }
  }
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {} }

  function statusText() {
    var t = '';
    if (lastSync) { var d = new Date(lastSync); t = pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    switch (status) {
      case 'synced': return '✓ تمت المزامنة' + (t ? ' — ' + t : '');
      case 'syncing': return '… جاري المزامنة';
      case 'pending': return 'تغييرات بانتظار المزامنة';
      case 'offline': return 'لا يوجد اتصال — ستتزامن تلقائيًا عند عودة الإنترنت';
      case 'error': return 'تعذرت المزامنة' + (lastErr ? ' — ' + lastErr : '');
      default: return 'لم تتم المزامنة بعد';
    }
  }
  function setStatus(s, err) {
    status = s;
    if (err) lastErr = (err && err.message) ? err.message : String(err);
    var dot = document.querySelector('.sync-dot');
    if (dot) {
      dot.classList.toggle('ok', s === 'synced');
      dot.classList.toggle('err', s === 'error');
      dot.title = statusText();
    }
    var el = $('cloudStatus');
    if (el) el.textContent = statusText();
  }

  /* ---------- دمج البيانات ----------
     الأرصدة (balances) هي الرصيد الحالي الثابت، ولا تُحسب أبدًا من سجل الحركات.
     عند التقاء جهازين: نبدأ من أرصدة السحابة ثم نطبّق فرق كل عملية محلية جديدة (إضافة/تعديل/حذف) مرة واحدة فقط.
       - حركة جديدة محليًا: يُضاف أثرها على الرصيد.
       - حركة محذوفة محليًا: يُعكس أثرها (إن كانت موجودة في السحابة).
       - حركة معدّلة (upd أحدث): يُعكس أثر القديمة ويُطبَّق أثر الجديدة.
       - الحذف يغلب التعديل. */
  function merge(local, remote) {
    if ((remote.epoch || '') !== (local.epoch || '')) return App().normalize(clone(remote)); // حصل "تصفير" على جهاز آخر
    var L = App().normalize(clone(local)), R = App().normalize(clone(remote));
    var bal = Object.assign({}, R.balances);
    var deleted = Object.assign({}, R.deleted);
    var map = {};
    R.tx.forEach(function (t) { map[t.id] = t; });
    Object.keys(L.deleted).forEach(function (id) {
      if (deleted[id]) return;
      deleted[id] = L.deleted[id];
      if (map[id]) { App().applyDelta(bal, map[id], -1); delete map[id]; }
    });
    L.tx.forEach(function (t) {
      if (deleted[t.id]) return;
      var r = map[t.id];
      if (!r) { App().applyDelta(bal, t, 1); map[t.id] = t; }
      else if ((t.upd || 0) > (r.upd || 0)) { App().applyDelta(bal, r, -1); App().applyDelta(bal, t, 1); map[t.id] = t; }
    });
    var tx = Object.keys(map).map(function (id) { return map[id]; })
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    return Object.assign({}, R, { balances: bal, tx: tx, deleted: deleted });
  }
  /* بصمة مختصرة للمقارنة (هل تغيّر شيء فعلًا؟) */
  function sig(d) {
    return JSON.stringify([d.epoch || '', d.balances, Object.keys(d.deleted || {}).sort(),
      d.tx.map(function (t) { return [t.id, t.upd || 0]; }).sort()]);
  }

  function applyLocal(next) {
    var before = JSON.stringify(App().getData());
    var after = JSON.stringify(next);
    if (before === after) return;
    App().setData(next);
    try { localStorage.setItem(App().STORAGE_KEY, after); } catch (e) {}
    if (!locked && started && !App().isBusy()) App().render();
  }

  /* ---------- المزامنة ---------- */
  function isNet(e) {
    return !navigator.onLine || /fetch|network|load failed/i.test((e && e.message) || '');
  }
  function isAuthErr(e) {
    return e && (e.status === 401 || e.code === 'PGRST301' || /jwt/i.test(e.message || ''));
  }

  async function doSync() {
    for (var attempt = 0; attempt < 4; attempt++) {
      var res = await sb.from('flow_state').select('data,rev').eq('user_id', uid).maybeSingle();
      if (res.error) throw res.error;
      var row = res.data;
      var ver = localVer;
      var local = App().getData();
      var toPush = null, rrev = 0;

      if (!row) {
        var ins = await sb.from('flow_state').insert({ user_id: uid, data: clone(local), rev: 1 });
        if (ins.error) { if (ins.error.code === '23505') continue; throw ins.error; }
        meta.rev = 1; meta.force = false; meta.dirty = localVer !== ver; saveMeta();
        return;
      }

      rrev = Number(row.rev);
      var remote = row.data;

      if (meta.force) {
        toPush = clone(local);
      } else if (rrev === meta.rev) {
        if (!meta.dirty) return;
        toPush = clone(local);
      } else {
        if (!App().valid(remote)) throw new Error('بيانات السحابة غير صالحة');
        var merged = merge(local, remote);
        applyLocal(merged);
        if (sig(merged) !== sig(App().normalize(clone(remote)))) {
          toPush = merged;
        } else {
          meta.rev = rrev; meta.dirty = false; saveMeta();
          return;
        }
      }

      var upd = await sb.from('flow_state')
        .update({ data: toPush, rev: rrev + 1, updated_at: new Date().toISOString() })
        .eq('user_id', uid).eq('rev', rrev).select('rev');
      if (upd.error) throw upd.error;
      if (!upd.data || !upd.data.length) continue; // تعارض: جهاز آخر كتب قبلنا، نعيد المحاولة
      meta.rev = rrev + 1; meta.force = false; meta.dirty = localVer !== ver; saveMeta();
      return;
    }
    throw new Error('تعذر حل تعارض المزامنة، حاول مرة أخرى');
  }

  async function sync() {
    if (!sb || !uid) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (syncing) { queued = true; return; }
    syncing = true; setStatus('syncing');
    try {
      await doSync();
      lastSync = Date.now();
      setStatus(meta.dirty ? 'pending' : 'synced');
    } catch (e) {
      console.error('FLOW sync:', e);
      if (isAuthErr(e) && navigator.onLine) { uid = null; showLogin('انتهت الجلسة. سجّل الدخول من جديد.'); setStatus('error', e); }
      else setStatus(isNet(e) ? 'offline' : 'error', e);
    } finally {
      syncing = false;
      if (queued || (meta.dirty && status === 'pending')) {
        queued = false; clearTimeout(timer); timer = setTimeout(sync, 600);
      }
    }
  }

  function changed() {
    localVer++; meta.dirty = true; saveMeta();
    if (!uid) return;
    setStatus(navigator.onLine ? 'pending' : 'offline');
    clearTimeout(timer); timer = setTimeout(sync, 800);
  }
  function markForce() { meta.force = true; saveMeta(); }

  /* ---------- شاشات الدخول والقفل ---------- */
  var gate = null;
  var brand = '<div class="brand" style="justify-content:center;margin-bottom:26px"><span class="brand-symbol" aria-hidden="true">≋</span><span>FLOW</span></div>';

  function showGate(html) {
    document.body.classList.remove('privacy');
    document.body.classList.add('gated');
    gate.hidden = false;
    gate.innerHTML = '<div class="gate-card">' + brand + html + SIGN + '</div>';
  }
  function hideGate() {
    gate.hidden = true; gate.innerHTML = '';
    document.body.classList.remove('gated', 'privacy');
  }
  function gateMessage(msg, isWarn) {
    showGate('<div class="panel"><p class="' + (isWarn ? 'warn' : 'page-sub') + '" style="margin:0">' + esc(msg) + '</p></div>');
  }

  function showLogin(msg) {
    started = false;
    showGate(
      '<div class="panel">' +
      '<h1 class="page-title">تسجيل الدخول</h1>' +
      '<p class="page-sub">أدخل بيانات حسابك للوصول إلى أرصدتك.</p>' +
      '<label class="field-label" for="authEmail">البريد الإلكتروني</label>' +
      '<input class="field" id="authEmail" type="email" dir="ltr" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false"/>' +
      '<label class="field-label" for="authPass">كلمة المرور</label>' +
      '<input class="field" id="authPass" type="password" dir="ltr" autocomplete="current-password"/>' +
      '<p class="warn" id="authErr" ' + (msg ? '' : 'hidden') + '>' + esc(msg || '') + '</p>' +
      '<button class="btn primary full" id="authLogin" style="margin-top:14px">دخول</button>' +
      '<button class="btn ghost full" id="authInstall" style="margin-top:10px" hidden>تثبيت التطبيق على هذا الجهاز</button>' +
      '</div>'
    );
    var prev = null;
    try { prev = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) {}
    if (prev && prev.email) $('authEmail').value = prev.email;
    $('authLogin').onclick = doLogin;
    if (deferredInstall && !isStandalone()) $('authInstall').hidden = false;
    $('authPass').onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
    $('authEmail').onkeydown = function (e) { if (e.key === 'Enter') $('authPass').focus(); };
  }

  function authErr(msg) {
    var el = $('authErr'); if (!el) return;
    el.textContent = msg; el.hidden = false;
    var b = $('authLogin'); if (b) { b.disabled = false; b.textContent = 'دخول'; }
  }

  async function doLogin() {
    var em = $('authEmail').value.trim(), pw = $('authPass').value;
    if (!em || !pw) { authErr('أدخل البريد الإلكتروني وكلمة المرور.'); return; }
    if (!navigator.onLine) { authErr('لا يوجد اتصال بالإنترنت. تسجيل الدخول يحتاج اتصالًا.'); return; }
    var btn = $('authLogin'); btn.disabled = true; btn.textContent = 'جاري الدخول…';
    var r;
    try { r = await sb.auth.signInWithPassword({ email: em, password: pw }); }
    catch (e) { authErr('تعذر الاتصال بالخادم. حاول مرة أخرى.'); return; }
    if (r.error || !r.data || !r.data.user) {
      var m = (r.error && r.error.message) || '';
      authErr(/invalid login/i.test(m) ? 'البريد أو كلمة المرور غير صحيحة.' : 'تعذر تسجيل الدخول' + (m ? ': ' + m : '.'));
      return;
    }
    var user = r.data.user;
    var prev = null;
    try { prev = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) {}
    if (prev && prev.uid && prev.uid !== user.id) wipeLocal(); // حساب مختلف: لا نخلط البيانات
    uid = user.id; email = user.email || em;
    try {
      localStorage.setItem(AUTH_FLAG, '1');
      localStorage.setItem(USER_KEY, JSON.stringify({ uid: uid, email: email }));
    } catch (e) {}
    await enter();
  }

  function wipeLocal() {
    try {
      localStorage.removeItem(App().STORAGE_KEY);
      localStorage.removeItem(META_KEY);
      localStorage.removeItem(LOCK_KEY);
      localStorage.removeItem(PIN_KEY);
      [QA_KEY, QA_FAIL_KEY, PIN_FAIL_KEY, SETUP_KEY].forEach(function (k) { localStorage.removeItem(k); });
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('sb-') === 0) localStorage.removeItem(k); });
    } catch (e) {}
    meta = { rev: null, dirty: false, force: false };
    App().setData(App().defaultData());
  }

  async function enter() {
    gateMessage('جاري تحميل بياناتك…');
    if (navigator.onLine) {
      await Promise.race([sync(), new Promise(function (r) { setTimeout(r, 8000); })]);
    }
    started = true;
    hideGate();
    App().render();
    startTimers();
    setTimeout(maybeSetup, 700);
  }

  /* ---------- القفل بالبصمة (WebAuthn) ---------- */
  var b64u = {
    enc: function (buf) {
      var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec: function (str) {
      str = str.replace(/-/g, '+').replace(/_/g, '/');
      while (str.length % 4) str += '=';
      return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); });
    }
  };
  function bioEnabled() { return !!localStorage.getItem(LOCK_KEY); }
  function pinEnabled() { return !!localStorage.getItem(PIN_KEY); }
  function lockEnabled() { return bioEnabled() || pinEnabled(); }

  /* ---------- رمز PIN داخلي + سؤال أمان سري ----------
     الرمز وإجابة السؤال يُخزَّنان مشتقَّين بـ PBKDF2 (لا يُحفظ أي منهما كنص).
     بعد 5 محاولات خاطئة للرمز: انتظار دقيقة. وللإجابة: انتظار 5 دقائق. */
  function readJson(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } }
  function lockLeft(k) { var f = readJson(k); return f.until && Date.now() < f.until ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
  function noteFail(k, limit, ms) {
    var f = readJson(k); f.n = (f.n || 0) + 1;
    if (f.n >= limit) { f.n = 0; f.until = Date.now() + ms; }
    localStorage.setItem(k, JSON.stringify(f));
    return f.until && Date.now() < f.until ? Math.ceil(ms / 1000) : 0;
  }
  function waitText(sec) { return sec >= 60 ? Math.ceil(sec / 60) + ' دقيقة' : sec + ' ثانية'; }
  async function pinHash(pin, saltB64, iter) {
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64u.dec(saltB64), iterations: iter }, key, 256);
    return b64u.enc(bits);
  }
  async function setPin(pin) {
    var salt = b64u.enc(crypto.getRandomValues(new Uint8Array(16))), iter = 150000;
    localStorage.setItem(PIN_KEY, JSON.stringify({ salt: salt, iter: iter, hash: await pinHash(pin, salt, iter) }));
    localStorage.removeItem(PIN_FAIL_KEY);
  }
  async function checkPin(pin) {
    var w = lockLeft(PIN_FAIL_KEY); if (w) return { ok: false, wait: w };
    var rec = JSON.parse(localStorage.getItem(PIN_KEY));
    if ((await pinHash(pin, rec.salt, rec.iter)) === rec.hash) { localStorage.removeItem(PIN_FAIL_KEY); return { ok: true }; }
    return { ok: false, wait: noteFail(PIN_FAIL_KEY, 5, 60000) };
  }
  /* توحيد الإجابة: لا فرق بين الأحرف الكبيرة/الصغيرة، التشكيل، أ/إ/آ، ة/ه، ى/ي، الأرقام الهندية/اللاتينية، المسافات */
  function normAns(str) {
    var d = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
    return String(str || '').toLowerCase()
      .replace(/[٠-٩۰-۹]/g, function (c) { return d[c]; })
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ک/g, 'ك')
      .replace(/[^\u0621-\u063A\u0641-\u064Aa-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function qaRecord() { try { return JSON.parse(localStorage.getItem(QA_KEY) || 'null'); } catch (e) { return null; } }
  async function setQA(q, a) {
    var salt = b64u.enc(crypto.getRandomValues(new Uint8Array(16))), iter = 150000;
    localStorage.setItem(QA_KEY, JSON.stringify({ q: q, salt: salt, iter: iter, hash: await pinHash(normAns(a), salt, iter) }));
    localStorage.removeItem(QA_FAIL_KEY);
  }
  async function checkAnswer(a) {
    var w = lockLeft(QA_FAIL_KEY); if (w) return { ok: false, wait: w };
    var rec = qaRecord(); if (!rec) return { ok: false, none: true };
    if ((await pinHash(normAns(a), rec.salt, rec.iter)) === rec.hash) { localStorage.removeItem(QA_FAIL_KEY); return { ok: true }; }
    return { ok: false, wait: noteFail(QA_FAIL_KEY, 5, 300000) };
  }

  async function bioSupported() {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { return false; }
  }
  async function verifyBio() {
    var id = b64u.dec(localStorage.getItem(LOCK_KEY));
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: id, transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000
      }
    });
  }
  async function enableLock() {
    if (!window.isSecureContext || !window.PublicKeyCredential) {
      App().notify('المتصفح لا يدعم القفل. استخدم Chrome أو Safari عبر رابط https'); return false;
    }
    if (!(await bioSupported())) {
      App().notify('فعّل قفل الشاشة في الهاتف (بصمة أو رمز) من إعدادات الهاتف ثم أعد المحاولة'); return false;
    }
    try {
      var cred = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'FLOW', id: location.hostname },
          user: { id: new TextEncoder().encode(uid || 'flow-user'), name: email || 'flow', displayName: 'FLOW' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
          attestation: 'none',
          timeout: 60000
        }
      });
      localStorage.setItem(LOCK_KEY, b64u.enc(cred.rawId));
      return true;
    } catch (e) {
      var n = e && e.name;
      if (n === 'NotAllowedError') App().notify('تم إلغاء التحقق أو انتهت المهلة');
      else if (n === 'SecurityError') App().notify('لا يمكن تفعيل القفل على هذا العنوان');
      else if (n === 'InvalidStateError') App().notify('القفل مفعّل مسبقًا على هذا الجهاز');
      else { console.error(e); App().notify('تعذر تفعيل القفل على هذا الجهاز'); }
      return false;
    }
  }

  var unlockFn = null;

  function openModal(inner) {
    closeModal();
    var m = document.createElement('div');
    m.className = 'fmodal'; m.id = 'fmodal';
    m.innerHTML = '<div class="fmodal-card" role="dialog" aria-modal="true">' + inner + '</div>';
    document.body.appendChild(m);
    return m;
  }
  function closeModal() { var m = $('fmodal'); if (m) m.remove(); }
  function modalMsg(t) { var m = $('fmMsg'); if (m) { m.textContent = t; m.hidden = false; } }
  var numField = function (id, ph) {
    return '<input class="field" id="' + id + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" dir="ltr" autocomplete="off" placeholder="' + ph + '" style="text-align:center;letter-spacing:5px;margin-bottom:8px"/>';
  };

  /* نافذة "نسيت الرمز؟": إجابة سؤال الأمان ثم رمز جديد، بدون إيميل */
  function forgotModal() {
    var rec = qaRecord();
    if (!rec) {
      openModal('<div class="fmodal-icon" aria-hidden="true">🔑</div><h2>استعادة الرمز</h2>' +
        '<p class="page-sub">لم يتم ضبط سؤال أمان لهذا الرمز، فلا يمكن استعادته من هنا. سجّل الخروج ثم ادخل بكلمة مرور حسابك.</p>' +
        '<div class="fmodal-actions"><button class="btn secondary" id="fmClose">إغلاق</button><button class="btn danger" id="fmLogout">تسجيل الخروج</button></div>');
      $('fmClose').onclick = closeModal;
      $('fmLogout').onclick = function () { closeModal(); logout(); };
      return;
    }
    openModal('<div class="fmodal-icon" aria-hidden="true">🔑</div><h2>استعادة الرمز</h2>' +
      '<p class="page-sub">أجب عن سؤال الأمان السري الذي اخترته لإعادة تعيين الرمز.</p>' +
      '<div class="fmodal-q">' + esc(rec.q) + '</div>' +
      '<input class="field" id="fmAns" autocomplete="off" placeholder="إجابتك"/>' +
      '<p class="warn" id="fmMsg" hidden></p>' +
      '<div class="fmodal-actions"><button class="btn secondary" id="fmCancel">إلغاء</button><button class="btn primary" id="fmVerify">تحقق</button></div>');
    var verify = async function () {
      var a = $('fmAns').value;
      if (!normAns(a)) { modalMsg('اكتب إجابتك.'); return; }
      var r = await checkAnswer(a);
      if (r.ok) { newPinStep(); return; }
      $('fmAns').value = '';
      modalMsg(r.wait ? 'محاولات كثيرة. انتظر ' + waitText(r.wait) + ' ثم حاول مرة أخرى.' : 'الإجابة غير صحيحة.');
    };
    $('fmCancel').onclick = closeModal;
    $('fmVerify').onclick = verify;
    $('fmAns').onkeydown = function (e) { if (e.key === 'Enter') verify(); };
    setTimeout(function () { var i = $('fmAns'); if (i) i.focus(); }, 120);
  }
  function newPinStep() {
    openModal('<div class="fmodal-icon" aria-hidden="true">✅</div><h2>رمز جديد</h2>' +
      '<p class="page-sub">تم التحقق. اختر رمز PIN جديدًا من 4 إلى 8 أرقام.</p>' +
      numField('fmPin', 'الرمز الجديد') + numField('fmPin2', 'أعد كتابة الرمز') +
      '<p class="warn" id="fmMsg" hidden></p>' +
      '<div class="fmodal-actions"><button class="btn secondary" id="fmCancel">إلغاء</button><button class="btn primary" id="fmSave">حفظ وفتح التطبيق</button></div>');
    var save = async function () {
      var a = $('fmPin').value, b = $('fmPin2').value;
      if (!/^[0-9]{4,8}$/.test(a)) { modalMsg('الرمز يجب أن يكون من 4 إلى 8 أرقام.'); return; }
      if (a !== b) { modalMsg('الرمزان غير متطابقين.'); return; }
      await setPin(a);
      closeModal();
      if (unlockFn) unlockFn();
    };
    $('fmCancel').onclick = closeModal;
    $('fmSave').onclick = save;
    $('fmPin2').onkeydown = function (e) { if (e.key === 'Enter') save(); };
    setTimeout(function () { var i = $('fmPin'); if (i) i.focus(); }, 120);
  }

  function showLock() {
    return new Promise(function (resolve) {
      locked = true;
      var bio = bioEnabled(), pin = pinEnabled();
      showGate(
        '<div class="panel" style="text-align:center">' +
        '<div class="lock-icon" aria-hidden="true">🔒</div>' +
        '<h1 class="page-title">FLOW مقفل</h1>' +
        '<p class="page-sub">' + (pin && bio ? 'افتح بالبصمة أو أدخل رمز PIN.' : pin ? 'أدخل رمز PIN للمتابعة.' : 'افتح بالبصمة أو الوجه للمتابعة.') + '</p>' +
        (pin ? '<input class="field" id="lockPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" dir="ltr" autocomplete="off" placeholder="رمز PIN" style="text-align:center;letter-spacing:6px"/>' : '') +
        '<p class="warn" id="lockMsg" hidden></p>' +
        (pin ? '<button class="btn primary full" id="lockPinBtn" style="margin-top:10px">فتح</button>' : '') +
        (bio ? '<button class="btn ' + (pin ? 'secondary' : 'primary') + ' full" id="lockUnlock" style="margin-top:10px">فتح بالبصمة</button>' : '') +
        (pin ? '<button class="link-btn" id="lockForgot">نسيت الرمز؟</button>' : '') +
        '<button class="btn ghost full" id="lockLogout" style="margin-top:10px">تسجيل الخروج</button>' +
        '</div>'
      );
      var msg = function (t) { var m = $('lockMsg'); if (m) { m.textContent = t; m.hidden = false; } };
      var done = function () { locked = false; unlockFn = null; hideGate(); resolve(); };
      unlockFn = done;
      var tryBio = async function (auto) {
        try { await verifyBio(); done(); }
        catch (e) { if (!auto) msg('لم يتم التحقق بالبصمة. حاول مرة أخرى أو استخدم الرمز.'); }
      };
      var tryPin = async function () {
        var v = ($('lockPin').value || '').trim();
        if (v.length < 4) { msg('أدخل 4 أرقام على الأقل.'); return; }
        var r = await checkPin(v);
        if (r.ok) { done(); return; }
        $('lockPin').value = '';
        msg(r.wait ? 'محاولات كثيرة. انتظر ' + waitText(r.wait) + ' ثم حاول مرة أخرى.' : 'الرمز غير صحيح.');
      };
      if (bio) $('lockUnlock').onclick = function () { tryBio(false); };
      if (pin) {
        $('lockPinBtn').onclick = tryPin;
        $('lockPin').onkeydown = function (e) { if (e.key === 'Enter') tryPin(); };
        $('lockForgot').onclick = forgotModal;
      }
      $('lockLogout').onclick = function () { logout(); };
      if (bio) setTimeout(function () { tryBio(true); }, 350);
      else if (pin) setTimeout(function () { var i = $('lockPin'); if (i) i.focus(); }, 200);
    });
  }

  /* ---------- تسجيل الخروج والتصدير ---------- */
  async function logout() {
    if (meta.dirty && navigator.onLine && uid) await sync();
    var msg = meta.dirty
      ? 'توجد تغييرات لم تتم مزامنتها وستضيع إذا سجّلت الخروج الآن. هل تريد المتابعة؟'
      : 'تسجيل الخروج؟ ستحتاج لكلمة المرور للدخول مرة ثانية.';
    if (!confirm(msg)) return;
    loggingOut = true;
    try { await sb.auth.signOut(); } catch (e) {}
    try {
      [App().STORAGE_KEY, META_KEY, LOCK_KEY, PIN_KEY, PIN_FAIL_KEY, QA_KEY, QA_FAIL_KEY, SETUP_KEY, AUTH_FLAG, USER_KEY].forEach(function (k) { localStorage.removeItem(k); });
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('sb-') === 0) localStorage.removeItem(k); });
    } catch (e) {}
    location.reload();
  }

  /* حفظ/مشاركة ملف: على iPhone تُستخدم قائمة المشاركة، وغيره تنزيل مباشر */
  async function saveFile(file) {
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    App().notify('تم تنزيل الملف');
  }
  var today = function () { return new Date().toISOString().slice(0, 10); };

  async function exportBackup() {
    var json = JSON.stringify({ app: 'FLOW', exportedAt: new Date().toISOString(), data: App().getData() }, null, 2);
    await saveFile(new File([json], 'flow-backup-' + today() + '.json', { type: 'application/json' }));
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function currencyOf(k) { return k === 'ils' ? 'ILS' : 'USD'; }
  function exportRows() {
    var A = App(), n = A.names, d = A.getData();
    var head = ['التاريخ', 'النوع', 'البيان', 'من حساب', 'إلى حساب', 'المبلغ', 'عملة المبلغ', 'الرسوم', 'الصافي المضاف', 'عملة الصافي'];
    var rows = d.tx.slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); }).map(function (t) {
      var type, from = '', to = '', cur = 'USD', net = '', netCur = '';
      if (t.kind === 'transfer') { type = 'تحويل'; from = n[t.from] || t.from; to = n[t.to] || t.to; cur = currencyOf(t.from); net = t.received; netCur = currencyOf(t.to); }
      else if (t.kind === 'manual') { type = t.sign > 0 ? 'إضافة رصيد' : 'خصم رصيد'; from = n[t.wallet] || t.wallet; cur = currencyOf(t.wallet); }
      else if (t.kind === 'profit') type = 'ربح';
      else type = 'مصروف';
      return [fmtDate(t.date), type, t.title, from, to, t.amount, cur, t.fees || 0, net, netCur];
    });
    var bal = Object.keys(n).map(function (k) { return [n[k], d.balances[k], currencyOf(k)]; });
    return { head: head, rows: rows, balHead: ['الحساب', 'الرصيد الحالي', 'العملة'], bal: bal };
  }

  function csvCell(v) {
    if (v === null || v === undefined) v = '';
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) v = "'" + v; // منع تنفيذ معادلات داخل Excel
    v = String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function buildCsv() {
    var r = exportRows();
    return '\ufeff' + [r.head].concat(r.rows).map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
  }
  async function exportCsv() {
    await saveFile(new File([buildCsv()], 'flow-operations-' + today() + '.csv', { type: 'text/csv;charset=utf-8' }));
  }

  /* ملف Excel (.xlsx) حقيقي بدون مكتبات: حزمة ZIP بسيطة + ورقتان (العمليات، الأرصدة) */
  function crc32(buf) {
    if (!crc32.t) { crc32.t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    var enc = new TextEncoder(), chunks = [], central = [], offset = 0, dt = new Date();
    var dosTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
    var dosDate = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
    files.forEach(function (f) {
      var nameB = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data), size = data.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nameB, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nameB.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameB);
      offset += 30 + nameB.length + size;
    });
    var cdSize = 0; central.forEach(function (c) { cdSize += c.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function colName(i) { var s2 = ''; i++; while (i > 0) { var m = (i - 1) % 26; s2 = String.fromCharCode(65 + m) + s2; i = Math.floor((i - 1) / 26); } return s2; }
  function xmlEsc(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
  function sheetXml(head, rows, widths) {
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/><cols>' +
      widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') +
      '</cols><sheetData>';
    [head].concat(rows).forEach(function (r, ri) {
      x += '<row r="' + (ri + 1) + '">';
      r.forEach(function (v, ci) {
        var ref = colName(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) x += '<c r="' + ref + '" s="2"><v>' + v + '</v></c>';
        else if (v === '' || v === null || v === undefined) x += '<c r="' + ref + '"' + (ri === 0 ? ' s="1"' : '') + '/>';
        else x += '<c r="' + ref + '" t="inlineStr"' + (ri === 0 ? ' s="1"' : '') + '><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      });
      x += '</row>';
    });
    return x + '</sheetData></worksheet>';
  }
  function buildXlsx() {
    var r = exportRows(), NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zipStore([
      { name: '[Content_Types].xml', text: H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', text: H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: H + '<workbook xmlns="' + NS + '" xmlns:r="' + REL + '"><sheets><sheet name="العمليات" sheetId="1" r:id="rId1"/><sheet name="الأرصدة" sheetId="2" r:id="rId2"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + REL + '/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="' + REL + '/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', text: H + '<styleSheet xmlns="' + NS + '"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F0E8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', text: sheetXml(r.head, r.rows, [17, 13, 34, 14, 14, 12, 12, 10, 14, 12]) },
      { name: 'xl/worksheets/sheet2.xml', text: sheetXml(r.balHead, r.bal, [18, 16, 10]) }
    ]);
  }
  async function exportXlsx() {
    await saveFile(new File([buildXlsx()], 'flow-operations-' + today() + '.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  /* ---------- الإعدادات ---------- */
  function settingsHTML() {
    var btn = function (id, label, extra) { return '<button class="btn secondary full" id="' + id + '" style="margin-top:10px"' + (extra || '') + '>' + label + '</button>'; };
    return '<p class="page-sub">الحساب: <b dir="ltr">' + esc(email || '—') + '</b></p>' +
      '<div class="notice" id="cloudStatus"></div>' +
      '<button class="btn secondary full" id="cloudSync" style="margin-top:12px">مزامنة الآن</button>' +
      btn('cloudLock', '') + btn('cloudPin', '') +
      '<p class="helper" style="margin-top:6px">القفل (البصمة / رمز PIN) يخص هذا الجهاز فقط. يُقفل التطبيق عند فتحه وبعد 30 ثانية في الخلفية.</p>' +
      '<div class="btn-row"><button class="btn secondary" id="cloudXlsx">تصدير Excel</button><button class="btn secondary" id="cloudCsv">تصدير CSV</button></div>' +
      btn('cloudExport', 'نسخة احتياطية كاملة (JSON)') +
      btn('cloudPass', 'تغيير كلمة المرور') + btn('cloudInstall', 'تثبيت التطبيق على هذا الجهاز', ' hidden');
  }
  function afterSettings() {
    setStatus(status);
    var b = $('cloudLock');
    if (b) b.textContent = bioEnabled() ? 'إيقاف القفل بالبصمة' : 'تفعيل القفل بالبصمة';
    var pb = $('cloudPin');
    if (pb) pb.textContent = pinEnabled() ? 'إدارة رمز PIN' : 'تفعيل رمز PIN';
    var ib = $('cloudInstall');
    if (ib) ib.hidden = !(deferredInstall && !isStandalone());
  }

  /* التثبيت المباشر: بدون نوافذ إرشادية. يظهر زر "تثبيت" فقط عندما يسمح المتصفح بذلك. */
  var deferredInstall = null;
  function isStandalone() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferredInstall = e;
    var ai = $('authInstall'); if (ai && !isStandalone()) ai.hidden = false;
    var ci = $('cloudInstall'); if (ci && !isStandalone()) ci.hidden = false;
  });
  window.addEventListener('appinstalled', function () {
    deferredInstall = null;
    var ai = $('authInstall'); if (ai) ai.hidden = true;
    var ci = $('cloudInstall'); if (ci) ci.hidden = true;
  });
  async function doInstall() {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (er) {}
    deferredInstall = null; afterSettings();
    var ai = $('authInstall'); if (ai) ai.hidden = true;
  }

  /* ---------- نوافذ الرمز وسؤال الأمان (الإعدادات) ---------- */
  function fld(id, label) {
    return '<label class="field-label" for="' + id + '">' + label + '</label><input class="field" id="' + id + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" dir="ltr" autocomplete="off"/>';
  }
  function qaFields() {
    return '<label class="field-label" for="qaSel">سؤال الأمان السري</label>' +
      '<select class="field" id="qaSel">' + QUESTIONS.map(function (q) { return '<option value="' + esc(q) + '">' + esc(q) + '</option>'; }).join('') + '<option value="__custom">سؤال من اختياري…</option></select>' +
      '<input class="field" id="qaCustom" placeholder="اكتب سؤالك" hidden style="margin-top:8px"/>' +
      '<label class="field-label" for="qaAns">الإجابة</label><input class="field" id="qaAns" autocomplete="off"/>' +
      '<p class="helper">تُستخدم لاستعادة الرمز إذا نسيته. تذكّرها جيدًا؛ لا يُشترط الالتزام بحالة الأحرف أو التشكيل.</p>';
  }
  function wireQa() {
    var sel = $('qaSel'), cus = $('qaCustom');
    if (sel && cus) sel.addEventListener('change', function () { cus.hidden = sel.value !== '__custom'; if (!cus.hidden) cus.focus(); });
  }
  function readQa() {
    var sel = $('qaSel').value, q = sel === '__custom' ? ($('qaCustom').value || '').trim() : sel;
    if (q.length < 6) return { err: 'اكتب سؤالًا واضحًا.' };
    if (normAns($('qaAns').value).length < 2) return { err: 'أدخل إجابة (حرفان على الأقل).' };
    return { q: q, a: $('qaAns').value };
  }
  var head = function (t) { return '<div class="dialog-head"><h2 class="dialog-title">' + t + '</h2><button class="close" data-close="true">×</button></div>'; };
  var DONE_NOTE = 'اختياري: ضع رمز PIN وسؤال أمان سري لحماية أرصدتك على هذا الجهاز. يمكنك تغييرهما لاحقًا من الإعدادات.';

  function pinDialog() {
    if (pinEnabled()) {
      App().showDialog(head('إدارة رمز PIN') + '<p class="page-sub">أدخل الرمز الحالي لإجراء أي تغيير.</p>' + fld('pinCur', 'الرمز الحالي') +
        '<div class="dialog-actions"><button class="btn secondary" id="pinChangeBtn">تغيير الرمز</button><button class="btn danger" id="pinOffBtn">إيقاف الرمز</button></div>' +
        '<button class="btn secondary full" id="qaChangeBtn" style="margin-top:10px">تغيير سؤال الأمان</button>');
    } else {
      App().showDialog(head('تفعيل رمز PIN') + '<p class="page-sub">اختر رمزًا من 4 إلى 8 أرقام، وسؤال أمان سريًّا لاستعادته إذا نسيته.</p>' +
        fld('pinNew', 'الرمز') + fld('pinNew2', 'أعد كتابة الرمز') + qaFields() +
        '<div class="dialog-actions"><button class="btn secondary" data-close="true">إلغاء</button><button class="btn primary" id="pinSave">حفظ</button></div>');
      wireQa();
    }
    afterSettings();
  }
  function maybeSetup() {
    if (localStorage.getItem(SETUP_KEY) || lockEnabled() || !started || locked) return;
    try { localStorage.setItem(SETUP_KEY, '1'); } catch (e) {}
    App().showDialog(head('تأمين تطبيقك') + '<p class="page-sub">' + DONE_NOTE + '</p>' +
      fld('pinNew', 'الرمز (4 إلى 8 أرقام)') + fld('pinNew2', 'أعد كتابة الرمز') + qaFields() +
      '<div class="dialog-actions"><button class="btn secondary" data-close="true">لاحقًا</button><button class="btn primary" id="pinSave">حفظ</button></div>');
    wireQa();
  }

  async function changePassword() {
    if (!navigator.onLine) { App().notify('تغيير كلمة المرور يحتاج اتصالًا بالإنترنت'); return; }
    var p1 = prompt('كلمة المرور الجديدة (8 أحرف على الأقل):');
    if (p1 === null) return;
    if (p1.length < 8) { App().notify('كلمة المرور قصيرة، استخدم 8 أحرف على الأقل'); return; }
    var p2 = prompt('أعد كتابة كلمة المرور الجديدة:');
    if (p2 === null) return;
    if (p1 !== p2) { App().notify('كلمتا المرور غير متطابقتين'); return; }
    var r = await sb.auth.updateUser({ password: p1 });
    App().notify(r.error ? 'تعذر التغيير: ' + r.error.message : 'تم تغيير كلمة المرور');
  }

  async function needCurrentPin() {
    var cur = (($('pinCur') || {}).value || '').trim();
    var r = await checkPin(cur);
    if (!r.ok) App().notify(r.wait ? 'محاولات كثيرة، انتظر ' + waitText(r.wait) : 'الرمز الحالي غير صحيح');
    return r.ok;
  }

  document.addEventListener('click', async function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b || !b.id) return;
    switch (b.id) {
      case 'cloudSync':
        if (!navigator.onLine) { App().notify('لا يوجد اتصال بالإنترنت'); return; }
        await sync();
        App().notify(status === 'synced' ? 'تمت المزامنة' : 'تعذرت المزامنة');
        break;
      case 'cloudLock':
        if (bioEnabled()) {
          try { await verifyBio(); } catch (er) { App().notify('لم يتم التحقق'); return; }
          localStorage.removeItem(LOCK_KEY); App().notify('تم إيقاف القفل بالبصمة');
        } else if (await enableLock()) { App().notify('تم تفعيل القفل بالبصمة'); }
        afterSettings();
        break;
      case 'cloudPin': pinDialog(); break;
      case 'pinSave': {
        var p1 = ($('pinNew') || {}).value || '', p2 = ($('pinNew2') || {}).value || '';
        if (!/^[0-9]{4,8}$/.test(p1)) { App().notify('الرمز يجب أن يكون من 4 إلى 8 أرقام'); return; }
        if (p1 !== p2) { App().notify('الرمزان غير متطابقين'); return; }
        var qa = readQa(); if (qa.err) { App().notify(qa.err); return; }
        await setPin(p1); await setQA(qa.q, qa.a);
        try { localStorage.setItem(SETUP_KEY, '1'); } catch (er) {}
        App().closeDialog(); App().notify('تم تفعيل رمز PIN وسؤال الأمان');
        break;
      }
      case 'pinOffBtn':
        if (!(await needCurrentPin())) return;
        [PIN_KEY, QA_KEY, PIN_FAIL_KEY, QA_FAIL_KEY].forEach(function (k) { localStorage.removeItem(k); });
        App().closeDialog(); App().notify('تم إيقاف رمز PIN');
        break;
      case 'pinChangeBtn':
        if (!(await needCurrentPin())) return;
        App().showDialog(head('تغيير الرمز') + fld('pinNew', 'الرمز الجديد') + fld('pinNew2', 'أعد كتابة الرمز') +
          '<div class="dialog-actions"><button class="btn secondary" data-close="true">إلغاء</button><button class="btn primary" id="pinChangeSave">حفظ</button></div>');
        break;
      case 'pinChangeSave': {
        var n1 = ($('pinNew') || {}).value || '', n2 = ($('pinNew2') || {}).value || '';
        if (!/^[0-9]{4,8}$/.test(n1)) { App().notify('الرمز يجب أن يكون من 4 إلى 8 أرقام'); return; }
        if (n1 !== n2) { App().notify('الرمزان غير متطابقين'); return; }
        await setPin(n1); App().closeDialog(); App().notify('تم تغيير الرمز');
        break;
      }
      case 'qaChangeBtn':
        if (!(await needCurrentPin())) return;
        App().showDialog(head('تغيير سؤال الأمان') + qaFields() +
          '<div class="dialog-actions"><button class="btn secondary" data-close="true">إلغاء</button><button class="btn primary" id="qaSave">حفظ</button></div>');
        wireQa();
        break;
      case 'qaSave': {
        var q2 = readQa(); if (q2.err) { App().notify(q2.err); return; }
        await setQA(q2.q, q2.a); App().closeDialog(); App().notify('تم تحديث سؤال الأمان');
        break;
      }
      case 'cloudXlsx': exportXlsx(); break;
      case 'cloudCsv': exportCsv(); break;
      case 'cloudExport': exportBackup(); break;
      case 'cloudLogout': logout(); break;
      case 'cloudPass': changePassword(); break;
      case 'cloudInstall': case 'authInstall': doInstall(); break;
    }
  });

  /* ---------- مؤقتات وأحداث ---------- */
  var timersOn = false;
  function startTimers() {
    if (timersOn) return; timersOn = true;
    setInterval(function () { if (!document.hidden && !locked && uid) sync(); }, 60000);
    window.addEventListener('online', function () { if (uid) sync(); });
    window.addEventListener('offline', function () { setStatus('offline'); });
    document.addEventListener('visibilitychange', function () {
      if (!started) return;
      if (document.hidden) {
        hiddenAt = Date.now();
        if (lockEnabled() && !locked) document.body.classList.add('privacy');
      } else {
        var away = Date.now() - hiddenAt;
        if (lockEnabled() && !locked && away > LOCK_AFTER_MS) showLock();
        else document.body.classList.remove('privacy');
        if (uid && !locked) sync();
      }
    });
  }

  /* ---------- البدء ---------- */
  async function start() {
    gate = $('gate');
    var dotHost = $('settingsBtn');
    if (dotHost && !dotHost.querySelector('.sync-dot')) {
      var d = document.createElement('span'); d.className = 'sync-dot'; d.setAttribute('aria-hidden', 'true'); dotHost.appendChild(d);
    }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('service-worker.js', { scope: './' }).catch(function (e) { console.warn('SW:', e); });
    }
    if (!window.supabase || !CFG.SUPABASE_URL || /YOUR-PROJECT/.test(CFG.SUPABASE_URL) || !CFG.SUPABASE_ANON_KEY || /YOUR-ANON/.test(CFG.SUPABASE_ANON_KEY)) {
      gateMessage('لم يتم إعداد Supabase بعد. افتح الملف config.js وضع رابط المشروع والمفتاح العام (anon).', true);
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    sb.auth.onAuthStateChange(function (ev) {
      if (ev === 'SIGNED_OUT' && !loggingOut && uid) { uid = null; setTimeout(function () { showLogin('انتهت الجلسة. سجّل الدخول من جديد.'); }, 0); }
    });

    var session = null;
    try { var r = await sb.auth.getSession(); session = r.data && r.data.session; } catch (e) {}

    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) {}

    if (session && session.user) {
      uid = session.user.id; email = session.user.email || (cached && cached.email) || '';
    } else if (localStorage.getItem(AUTH_FLAG) && cached && cached.uid && !navigator.onLine) {
      uid = cached.uid; email = cached.email || ''; // دخول بدون إنترنت من النسخة المحلية
    } else {
      showLogin(localStorage.getItem(AUTH_FLAG) ? 'انتهت الجلسة. سجّل الدخول من جديد.' : '');
      return;
    }

    if (lockEnabled()) { await showLock(); }
    await enter();
  }

  window.FlowCloud = { _csv: buildCsv, _xlsx: buildXlsx, _norm: normAns, _merge: merge, start: start, changed: changed, markForce: markForce, settingsHTML: settingsHTML, afterSettings: afterSettings };
})();

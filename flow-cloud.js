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
    var t = lastSync ? new Date(lastSync).toLocaleTimeString('ar-PS', { hour: '2-digit', minute: '2-digit' }) : '';
    switch (status) {
      case 'synced': return '✓ تمت المزامنة' + (t ? ' · ' + t : '');
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
     الحالة = رصيد افتتاحي لكل حساب + قائمة حركات + "شواهد حذف" (deleted).
     الدمج يعمل على مستوى كل عنصر، لذلك الإضافة والتعديل والحذف من أجهزة مختلفة لا تضيع:
       - الحركة: تُؤخذ النسخة الأحدث (upd)، والحذف يغلب التعديل.
       - الرصيد الافتتاحي: لكل حساب الأحدث (openingAt).
       - الأرصدة تُحسب من جديد دائمًا من الافتتاحي + الحركات. */
  function merge(local, remote) {
    if ((remote.epoch || '') !== (local.epoch || '')) return App().normalize(clone(remote)); // حصل "إعادة تعيين" على جهاز آخر
    var L = App().normalize(clone(local)), R = App().normalize(clone(remote));
    var deleted = Object.assign({}, L.deleted);
    Object.keys(R.deleted).forEach(function (k) { deleted[k] = Math.max(deleted[k] || 0, R.deleted[k]); });
    var map = {};
    L.tx.forEach(function (t) { map[t.id] = t; });
    R.tx.forEach(function (t) { var m = map[t.id]; if (!m || (t.upd || 0) >= (m.upd || 0)) map[t.id] = t; });
    var tx = Object.keys(map).filter(function (id) { return !deleted[id]; })
      .map(function (id) { return map[id]; })
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    var opening = {}, openingAt = {};
    Object.keys(Object.assign({}, L.opening, R.opening)).forEach(function (k) {
      var useL = (L.openingAt[k] || 0) > (R.openingAt[k] || 0);
      opening[k] = useL ? L.opening[k] : R.opening[k];
      openingAt[k] = Math.max(L.openingAt[k] || 0, R.openingAt[k] || 0);
    });
    var out = Object.assign({}, R, { tx: tx, deleted: deleted, opening: opening, openingAt: openingAt });
    out.balances = App().computeBalances(out);
    return out;
  }
  /* بصمة مختصرة للمقارنة (هل تغيّر شيء فعلًا؟) */
  function sig(d) {
    return JSON.stringify([d.epoch || '', d.balances, d.opening, d.openingAt, d.deleted,
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
    gate.innerHTML = '<div class="gate-card">' + brand + html + '</div>';
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
      '</div>'
    );
    var prev = null;
    try { prev = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) {}
    if (prev && prev.email) $('authEmail').value = prev.email;
    $('authLogin').onclick = doLogin;
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

  /* ---------- رمز PIN داخلي (بديل مضمون للبصمة) ----------
     يُخزَّن مشتقًا بـ PBKDF2 (لا يُحفظ الرمز نفسه). بعد 5 محاولات خاطئة: انتظار دقيقة. */
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
    var f = {}; try { f = JSON.parse(localStorage.getItem(PIN_FAIL_KEY) || '{}'); } catch (e) {}
    if (f.until && Date.now() < f.until) return { ok: false, wait: Math.ceil((f.until - Date.now()) / 1000) };
    var rec = JSON.parse(localStorage.getItem(PIN_KEY));
    var ok = (await pinHash(pin, rec.salt, rec.iter)) === rec.hash;
    if (ok) { localStorage.removeItem(PIN_FAIL_KEY); return { ok: true }; }
    f.n = (f.n || 0) + 1;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    localStorage.setItem(PIN_FAIL_KEY, JSON.stringify(f));
    return { ok: false, wait: f.until ? 60 : 0 };
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
        '<button class="btn ghost full" id="lockLogout" style="margin-top:10px">تسجيل الخروج</button>' +
        '</div>'
      );
      var msg = function (t) { var m = $('lockMsg'); if (m) { m.textContent = t; m.hidden = false; } };
      var done = function () { locked = false; hideGate(); resolve(); };
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
        msg(r.wait ? 'محاولات كثيرة. انتظر ' + r.wait + ' ثانية ثم حاول مرة أخرى.' : 'الرمز غير صحيح.');
      };
      if (bio) $('lockUnlock').onclick = function () { tryBio(false); };
      if (pin) {
        $('lockPinBtn').onclick = tryPin;
        $('lockPin').onkeydown = function (e) { if (e.key === 'Enter') tryPin(); };
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
      [App().STORAGE_KEY, META_KEY, LOCK_KEY, PIN_KEY, PIN_FAIL_KEY, AUTH_FLAG, USER_KEY].forEach(function (k) { localStorage.removeItem(k); });
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('sb-') === 0) localStorage.removeItem(k); });
    } catch (e) {}
    location.reload();
  }

  async function exportBackup() {
    var json = JSON.stringify({ app: 'FLOW', exportedAt: new Date().toISOString(), data: App().getData() }, null, 2);
    var name = 'flow-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    var file = new File([json], name, { type: 'application/json' });
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'FLOW backup' }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    App().notify('تم تنزيل النسخة الاحتياطية');
  }

  /* ---------- الإعدادات ---------- */
  function settingsHTML() {
    return '<p class="page-sub">الحساب: <b dir="ltr">' + esc(email || '—') + '</b></p>' +
      '<div class="notice" id="cloudStatus"></div>' +
      '<button class="btn secondary full" id="cloudSync" style="margin-top:12px">مزامنة الآن</button>' +
      '<button class="btn secondary full" id="cloudLock" style="margin-top:10px"></button>' +
      '<button class="btn secondary full" id="cloudPin" style="margin-top:10px"></button>' +
      '<p class="helper" style="margin-top:6px">القفل (البصمة / رمز PIN) يخص هذا الجهاز فقط. يُقفل التطبيق عند فتحه وبعد 30 ثانية في الخلفية.</p>' +
      '<button class="btn secondary full" id="cloudExport" style="margin-top:10px">تصدير نسخة احتياطية</button>' +
      '<button class="btn secondary full" id="cloudPass" style="margin-top:10px">تغيير كلمة المرور</button>' +
      '<button class="btn secondary full" id="cloudInstall" style="margin-top:10px" hidden>تثبيت التطبيق على هذا الجهاز</button>';
  }
  function afterSettings() {
    setStatus(status);
    var b = $('cloudLock');
    if (b) b.textContent = bioEnabled() ? 'إيقاف القفل بالبصمة' : 'تفعيل القفل بالبصمة';
    var pb = $('cloudPin');
    if (pb) pb.textContent = pinEnabled() ? 'إيقاف رمز PIN' : 'تفعيل رمز PIN';
    var ib = $('cloudInstall');
    if (ib) ib.hidden = !(deferredInstall && !isStandalone());
  }
  var deferredInstall = null;
  function isStandalone() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; });
  window.addEventListener('appinstalled', function () { deferredInstall = null; });

  function pinDialog() {
    var fld = function (id, label) {
      return '<label class="field-label" for="' + id + '">' + label + '</label><input class="field" id="' + id + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" dir="ltr" autocomplete="off"/>';
    };
    if (pinEnabled()) {
      App().showDialog('<div class="dialog-head"><h2 class="dialog-title">إيقاف رمز PIN</h2><button class="close" data-close="true">×</button></div>' +
        fld('pinCur', 'أدخل الرمز الحالي') +
        '<div class="dialog-actions"><button class="btn secondary" data-close="true">إلغاء</button><button class="btn danger" id="pinOffBtn">إيقاف</button></div>');
    } else {
      App().showDialog('<div class="dialog-head"><h2 class="dialog-title">تفعيل رمز PIN</h2><button class="close" data-close="true">×</button></div>' +
        '<p class="page-sub">اختر رمزًا من 4 إلى 8 أرقام. يُستخدم لفتح التطبيق على هذا الجهاز.</p>' +
        fld('pinNew', 'الرمز') + fld('pinNew2', 'أعد كتابة الرمز') +
        '<div class="dialog-actions"><button class="btn secondary" data-close="true">إلغاء</button><button class="btn primary" id="pinSave">حفظ</button></div>');
    }
    afterSettings();
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

  document.addEventListener('click', async function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b || !b.id) return;
    if (b.id === 'cloudSync') {
      if (!navigator.onLine) { App().notify('لا يوجد اتصال بالإنترنت'); return; }
      await sync();
      App().notify(status === 'synced' ? 'تمت المزامنة' : 'تعذرت المزامنة');
    } else if (b.id === 'cloudLock') {
      if (bioEnabled()) {
        try { await verifyBio(); } catch (er) { App().notify('لم يتم التحقق'); return; }
        localStorage.removeItem(LOCK_KEY); App().notify('تم إيقاف القفل');
      } else if (await enableLock()) { App().notify('تم تفعيل القفل بالبصمة'); }
      afterSettings();
    } else if (b.id === 'cloudExport') {
      exportBackup();
    } else if (b.id === 'cloudLogout') {
      logout();
    } else if (b.id === 'cloudPin') {
      pinDialog();
    } else if (b.id === 'pinSave') {
      var p1 = ($('pinNew') || {}).value || '', p2 = ($('pinNew2') || {}).value || '';
      if (!/^[0-9]{4,8}$/.test(p1)) { App().notify('الرمز يجب أن يكون من 4 إلى 8 أرقام'); return; }
      if (p1 !== p2) { App().notify('الرمزان غير متطابقين'); return; }
      await setPin(p1); App().closeDialog(); App().notify('تم تفعيل رمز PIN');
    } else if (b.id === 'pinOffBtn') {
      var cur = ($('pinCur') || {}).value || '';
      var r = await checkPin(cur.trim());
      if (!r.ok) { App().notify(r.wait ? 'محاولات كثيرة، انتظر قليلًا' : 'الرمز الحالي غير صحيح'); return; }
      localStorage.removeItem(PIN_KEY); App().closeDialog(); App().notify('تم إيقاف رمز PIN');
    } else if (b.id === 'cloudPass') {
      changePassword();
    } else if (b.id === 'cloudInstall' && deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (er) {}
      deferredInstall = null; afterSettings();
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

  window.FlowCloud = { start: start, changed: changed, markForce: markForce, settingsHTML: settingsHTML, afterSettings: afterSettings };
})();
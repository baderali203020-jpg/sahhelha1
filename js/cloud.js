/* سَهِّلها — الحسابات، المزامنة، المحتوى، الإشعارات والمساعد الحقيقي */
'use strict';

(() => {
  const cfg = window.SAHHELHA_CONFIG || {};
  const $ = id => document.getElementById(id);
  const siteUrl = cfg.SITE_URL || new URL('./', window.location.href).href.split('#')[0].split('?')[0];
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.SUPABASE_URL || '') &&
    typeof cfg.SUPABASE_ANON_KEY === 'string' && cfg.SUPABASE_ANON_KEY.length > 40 &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR_');

  let db = null;
  let session = null;
  let user = null;
  let profile = null;
  let bootingUserId = null;
  let cloudReady = false;
  let syncTimer = null;
  let syncBusy = false;
  let lastSerialized = '';
  let lastCloudUpdate = '';
  let realtimeChannel = null;
  let installPrompt = null;
  let authMode = 'login';
  let visitorTimer = null;
  let visitorTrackingUnavailable = false;

  const gate = $('cloudGate');

  function createVisitorId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  function visitorId() {
    try {
      let id = localStorage.getItem('SAHHELHA_VISITOR_ID');
      if (!id) { id = createVisitorId(); localStorage.setItem('SAHHELHA_VISITOR_ID', id); }
      return id;
    } catch { return createVisitorId(); }
  }

  function deviceType() {
    const ua = navigator.userAgent || '';
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  function browserName() {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'متصفح آخر';
  }

  function referrerHost() {
    try {
      if (!document.referrer) return null;
      const host = new URL(document.referrer).hostname;
      return host === location.hostname ? null : host;
    } catch { return null; }
  }

  async function trackVisit(isPageView = false) {
    if (!db || visitorTrackingUnavailable) return;
    const { error } = await db.rpc('track_visit', {
      p_visitor_id: visitorId(),
      p_path: location.pathname.slice(0, 300),
      p_device_type: deviceType(),
      p_browser: browserName(),
      p_referrer_host: referrerHost(),
      p_is_pageview: Boolean(isPageView)
    });
    if (error) {
      // لا نوقف التطبيق إذا لم تُشغل ترقية إحصاءات الزوار بعد.
      if (String(error.code || '').includes('PGRST') || /track_visit/i.test(error.message || '')) visitorTrackingUnavailable = true;
      console.warn('Visitor tracking:', error.message || error);
    }
  }

  function startVisitorTracking() {
    trackVisit(true);
    if (visitorTimer) clearInterval(visitorTimer);
    visitorTimer = setInterval(() => {
      if (document.visibilityState === 'visible') trackVisit(false);
    }, 60_000);
  }

  function showStatus(message, type = 'info') {
    const box = $('authStatus');
    if (!box) return;
    box.textContent = message;
    box.className = `auth-status show ${type}`;
  }

  function clearStatus() {
    const box = $('authStatus');
    if (box) box.className = 'auth-status';
  }

  function setButtonLoading(button, loading, label) {
    if (!button) return;
    if (loading) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.innerHTML = '<span class="cloud-spinner" aria-hidden="true"></span>';
    } else {
      button.disabled = false;
      button.textContent = label || button.dataset.label || 'متابعة';
    }
  }

  function setSyncStatus(state, text) {
    const pill = $('syncStatus');
    const label = $('syncText');
    if (!pill || !label) return;
    pill.className = `sync-pill ${state}`;
    label.textContent = text || ({ synced: 'تم الحفظ', syncing: 'جارٍ الحفظ', offline: 'دون اتصال', error: 'تعذر الحفظ' }[state] || 'السحابة');
  }

  function setAuthMode(mode) {
    authMode = mode;
    clearStatus();
    document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.toggle('on', tab.dataset.mode === mode));
    const nameField = $('authNameField');
    const submit = $('authSubmit');
    const forgot = $('forgotPassword');
    if (nameField) nameField.hidden = mode !== 'signup';
    if (submit) submit.textContent = mode === 'signup' ? 'إنشاء الحساب' : 'تسجيل الدخول';
    if (forgot) forgot.hidden = mode !== 'login';
  }

  function showGate() {
    if (gate) gate.classList.remove('is-hidden');
  }

  function hideGate() {
    if (gate) gate.classList.add('is-hidden');
  }

  function showSetupError() {
    showGate();
    const authUi = $('authUi');
    const setupUi = $('setupUi');
    if (authUi) authUi.hidden = true;
    if (setupUi) setupUi.hidden = false;
    showStatus('أكمل ربط Supabase أولًا، ثم أعد تحميل الصفحة.', 'info');
  }

  function safeClone(value, fallback) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return fallback; }
  }

  function metric(key, fallback = 0) {
    try { return SecureStorage.get(key, fallback); }
    catch { return fallback; }
  }

  function buildState() {
    return {
      version: 2,
      profile: {
        name: metric('na', profile?.name || ''),
        grade: metric('gr', profile?.grade || '')
      },
      tasks: safeClone(typeof tasks !== 'undefined' ? tasks : [], []),
      notes: safeClone(typeof notes !== 'undefined' ? notes : [], []),
      schedule: safeClone(typeof sch !== 'undefined' ? sch : {}, {}),
      exams: safeClone(typeof exams !== 'undefined' ? exams : [], []),
      metrics: {
        quizzes: metric('qz', 0), research: metric('rs', 0), gradeCalculations: metric('gc', 0),
        pomodoroSessions: metric('pm', 0), pomodoroMinutes: metric('pmMin', 0),
        pomodoroToday: metric('pmToday', { date: '', count: 0 }), flashcards: metric('fc', 0)
      }
    };
  }

  function hasMeaningfulState(state) {
    return Boolean(state?.profile?.name || state?.tasks?.length || state?.notes?.length || state?.exams?.length || Object.keys(state?.schedule || {}).length);
  }

  function applyState(state) {
    if (!state || typeof state !== 'object') return;
    const p = state.profile || {};
    if (p.name) SecureStorage.set('na', String(p.name).slice(0, 30));
    if (p.grade) SecureStorage.set('gr', String(p.grade).slice(0, 20));

    if (Array.isArray(state.tasks)) { tasks = state.tasks; SecureStorage.set('tasks', tasks); }
    if (Array.isArray(state.notes)) { notes = state.notes; SecureStorage.set('notes', notes); }
    if (state.schedule && typeof state.schedule === 'object') { sch = state.schedule; SecureStorage.set('sch', sch); }
    if (Array.isArray(state.exams)) { exams = state.exams; SecureStorage.set('exams', exams); }

    const m = state.metrics || {};
    const values = {
      qz: m.quizzes, rs: m.research, gc: m.gradeCalculations, pm: m.pomodoroSessions,
      pmMin: m.pomodoroMinutes, pmToday: m.pomodoroToday, fc: m.flashcards
    };
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null) SecureStorage.set(key, value);
    });
    renderCore();
  }

  function renderCore() {
    try { rT(); } catch {}
    try { rN(); } catch {}
    try { rSch(); } catch {}
    try { rEx(); } catch {}
    try { uCC(); } catch {}
    try { updStE(); } catch {}
    try { updTodayList(); } catch {}
    try { initGreet(); } catch {}
  }

  function showStudentApp() {
    const name = SecureStorage.get('na');
    const grade = SecureStorage.get('gr');
    const ob = $('ob');
    const app = $('app');
    if (name && grade) {
      if ($('dN')) $('dN').textContent = name;
      if (ob) ob.style.display = 'none';
      if (app) app.style.display = 'block';
      try { if (['1high', '2high', '3high'].includes(grade)) gF = grade; } catch {}
      renderCore();
    } else {
      if (app) app.style.display = 'none';
      const suggestedName = profile?.name || user?.user_metadata?.full_name || '';
      if ($('sN') && suggestedName) {
        $('sN').value = String(suggestedName).slice(0, 30);
        if ($('s1b')) $('s1b').disabled = false;
      }
      if (ob) {
        ob.style.display = 'flex';
        ob.classList.remove('bye');
      }
    }
  }

  function updateAccountUi() {
    const displayName = profile?.name || SecureStorage.get('na') || user?.user_metadata?.full_name || 'طالب';
    const email = user?.email || '';
    const role = profile?.role === 'admin' ? 'مدير المحتوى' : 'طالب';
    if ($('accountName')) $('accountName').textContent = displayName;
    if ($('accountEmail')) $('accountEmail').textContent = email;
    if ($('accountRole')) $('accountRole').textContent = role;
    if ($('accountAvatar')) $('accountAvatar').textContent = displayName.trim().charAt(0) || 'ط';
    document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('visible', profile?.role === 'admin'));
  }

  async function fetchProfile() {
    let { data, error } = await db.from('profiles').select('id,email,name,grade,role,updated_at').eq('id', user.id).maybeSingle();
    if (error) throw new Error(`تعذر قراءة الملف الشخصي: ${error.message}`);
    if (!data) {
      const payload = {
        id: user.id,
        email: user.email || null,
        name: user.user_metadata?.full_name || user.user_metadata?.name || null,
        grade: null
      };
      const result = await db.from('profiles').insert(payload).select('id,email,name,grade,role,updated_at').single();
      if (result.error) throw new Error(`تعذر إنشاء الملف الشخصي: ${result.error.message}`);
      data = result.data;
    }
    profile = data;
  }

  async function loadContent() {
    const fallback = SecureStorage.get('cloudContent', null);
    try {
      const [subjectsResult, questionsResult, cardsResult, resourcesResult] = await Promise.all([
        db.from('subjects').select('*').eq('active', true).order('sort_order'),
        db.from('questions').select('*').eq('active', true).order('created_at'),
        db.from('flashcards').select('*').eq('active', true).order('created_at'),
        db.from('resources').select('*').eq('active', true).order('sort_order')
      ]);
      for (const result of [subjectsResult, questionsResult, cardsResult, resourcesResult]) {
        if (result.error) throw result.error;
      }
      const content = {
        subjects: subjectsResult.data || [], questions: questionsResult.data || [],
        flashcards: cardsResult.data || [], resources: resourcesResult.data || []
      };
      SecureStorage.set('cloudContent', content);
      applyContent(content);
    } catch (error) {
      console.warn('Cloud content fallback:', error);
      if (fallback) applyContent(fallback);
    }
  }

  function cleanText(value, max = 300) {
    return String(value ?? '').replace(/[<>]/g, '').slice(0, max);
  }

  function applyContent(content) {
    if (Array.isArray(content.subjects) && content.subjects.length) {
      subs = content.subjects.map(row => ({
        id: row.code || row.id,
        dbId: row.id,
        name: cleanText(row.name, 100),
        icon: cleanText(row.icon || '📘', 8),
        grade: cleanText(row.grade, 20),
        gl: cleanText(row.grade_label, 50),
        sem: cleanText(row.semester, 20),
        semLabel: cleanText(row.semester_label, 50),
        units: Array.isArray(row.units) ? row.units.map(unit => ({
          name: cleanText(unit.name, 100),
          lessons: Array.isArray(unit.lessons) ? unit.lessons.map(lesson => cleanText(lesson, 200)) : []
        })) : []
      }));
    }

    if (Array.isArray(content.questions) && content.questions.length) {
      const grouped = {};
      for (const row of content.questions) {
        const category = cleanText(row.category, 40);
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push({
          q: cleanText(row.question, 500),
          opts: Array.isArray(row.options) ? row.options.map(option => cleanText(option, 250)) : [],
          correct: Number(row.correct_index) || 0,
          explain: cleanText(row.explanation, 700)
        });
      }
      Object.assign(quizBank, grouped);
      const select = $('qSub');
      if (select) {
        const labels = new Map(content.questions.map(q => [q.category, q.category_label || q.category]));
        select.innerHTML = '<option value="">اختر المادة</option>' + [...labels].map(([value, label]) =>
          `<option value="${cleanText(value, 40)}">${cleanText(label, 80)}</option>`).join('');
      }
    }

    if (Array.isArray(content.flashcards) && content.flashcards.length) {
      const grouped = {};
      for (const row of content.flashcards) {
        const category = cleanText(row.category, 40);
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push({ q: cleanText(row.question, 500), a: cleanText(row.answer, 1000) });
      }
      Object.assign(flashcards, grouped);
    }

    window.SahhelhaResources = Array.isArray(content.resources) ? content.resources : [];
  }

  async function bootstrap(nextSession) {
    if (!nextSession?.user || bootingUserId === nextSession.user.id) return;
    bootingUserId = nextSession.user.id;
    session = nextSession;
    user = nextSession.user;
    trackVisit(false);
    showGate();
    showStatus('جارٍ تحميل حسابك وبياناتك…', 'info');

    try {
      const lastUser = localStorage.getItem('SAHHELHA_LAST_USER');
      if (lastUser && lastUser !== user.id) SecureStorage.clear();
      const localBefore = buildState();

      await fetchProfile();
      const stateResult = await db.from('user_state').select('data,updated_at').eq('user_id', user.id).maybeSingle();
      if (stateResult.error) throw new Error(`تعذر تحميل بياناتك: ${stateResult.error.message}`);

      if (stateResult.data?.data) {
        applyState(stateResult.data.data);
        lastCloudUpdate = stateResult.data.updated_at || '';
      } else if (!lastUser && hasMeaningfulState(localBefore)) {
        const migrate = window.confirm('وجدنا بيانات محفوظة سابقًا على هذا الجهاز. هل تريد نقلها إلى حسابك السحابي؟');
        if (migrate) {
          await db.from('user_state').upsert({ user_id: user.id, data: localBefore }, { onConflict: 'user_id' });
          if (!profile.name && localBefore.profile?.name) {
            await saveProfile(localBefore.profile.name, localBefore.profile.grade || null, false);
          }
        } else {
          SecureStorage.clear();
        }
      } else if (lastUser !== user.id) {
        SecureStorage.clear();
      }

      if (profile?.name) SecureStorage.set('na', profile.name);
      if (profile?.grade) SecureStorage.set('gr', profile.grade);
      localStorage.setItem('SAHHELHA_LAST_USER', user.id);

      await loadContent();
      showStudentApp();
      updateAccountUi();
      await registerServiceWorker();
      startSync();
      subscribeRealtime();
      cloudReady = true;
      lastSerialized = JSON.stringify(buildState());
      setSyncStatus('synced', 'تم الحفظ');
      hideGate();
      clearStatus();
      handleRequestedPanel();
    } catch (error) {
      console.error(error);
      bootingUserId = null;
      showStatus(`${error.message}\nتأكد من تنفيذ ملف supabase/schema.sql.`, 'error');
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    clearStatus();
    const email = ($('authEmail')?.value || '').trim().toLowerCase();
    const password = $('authPassword')?.value || '';
    const name = ($('authName')?.value || '').trim();
    const button = $('authSubmit');
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return showStatus('اكتب بريدًا إلكترونيًا صحيحًا.', 'error');
    if (password.length < 8) return showStatus('كلمة المرور يجب أن تكون 8 أحرف على الأقل.', 'error');
    if (authMode === 'signup' && name.length < 2) return showStatus('اكتب اسمك.', 'error');

    setButtonLoading(button, true);
    try {
      if (authMode === 'signup') {
        const { data, error } = await db.auth.signUp({
          email, password,
          options: { data: { full_name: name }, emailRedirectTo: siteUrl }
        });
        if (error) throw error;
        if (!data.session) showStatus('تم إنشاء الحساب. افتح رسالة التأكيد في بريدك ثم سجّل الدخول.', 'ok');
        else await bootstrap(data.session);
      } else {
        const { data, error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await bootstrap(data.session);
      }
    } catch (error) {
      showStatus(authErrorMessage(error), 'error');
    } finally {
      setButtonLoading(button, false, authMode === 'signup' ? 'إنشاء الحساب' : 'تسجيل الدخول');
    }
  }

  function authErrorMessage(error) {
    const message = String(error?.message || error || 'حدث خطأ');
    if (/invalid login credentials/i.test(message)) return 'البريد أو كلمة المرور غير صحيحة.';
    if (/email not confirmed/i.test(message)) return 'أكد بريدك الإلكتروني أولًا.';
    if (/user already registered/i.test(message)) return 'هذا البريد مسجل مسبقًا. اختر تسجيل الدخول.';
    if (/password/i.test(message) && /least/i.test(message)) return 'اختر كلمة مرور أقوى.';
    if (/rate limit/i.test(message)) return 'محاولات كثيرة. انتظر قليلًا ثم حاول.';
    return `تعذر إكمال العملية: ${message}`;
  }

  async function configureAuthProviders() {
    try {
      const response = await fetch(`${cfg.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/settings`, {
        headers: { apikey: cfg.SUPABASE_ANON_KEY }, cache: 'no-store'
      });
      const settings = await response.json();
      const googleEnabled = Boolean(settings?.external?.google);
      if ($('googleLogin')) $('googleLogin').hidden = !googleEnabled;
      if ($('authDivider')) $('authDivider').hidden = !googleEnabled;
    } catch {
      if ($('googleLogin')) $('googleLogin').hidden = true;
      if ($('authDivider')) $('authDivider').hidden = true;
    }
  }

  async function googleLogin() {
    clearStatus();
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: siteUrl, queryParams: { access_type: 'offline', prompt: 'consent' } }
    });
    if (error) showStatus(authErrorMessage(error), 'error');
  }

  async function forgotPassword() {
    const email = ($('authEmail')?.value || '').trim().toLowerCase();
    if (!email) return showStatus('اكتب بريدك أولًا.', 'error');
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: siteUrl });
    if (error) showStatus(authErrorMessage(error), 'error');
    else showStatus('أرسلنا رابط إعادة تعيين كلمة المرور إلى بريدك.', 'ok');
  }

  async function saveProfile(name, grade, updateLocal = true) {
    if (!user || !db) return;
    const cleanName = String(name || '').trim().slice(0, 30);
    const cleanGrade = grade ? String(grade).slice(0, 20) : null;
    const { data, error } = await db.from('profiles')
      .update({ name: cleanName, grade: cleanGrade, updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('id,email,name,grade,role,updated_at').single();
    if (error) throw error;
    profile = data;
    if (updateLocal) {
      SecureStorage.set('na', cleanName);
      if (cleanGrade) SecureStorage.set('gr', cleanGrade);
    }
    updateAccountUi();
    await syncNow(true);
  }

  async function syncNow(force = false) {
    if (!cloudReady || !user || syncBusy || !navigator.onLine) {
      if (!navigator.onLine) setSyncStatus('offline', 'دون اتصال');
      return;
    }
    const state = buildState();
    const serialized = JSON.stringify(state);
    if (!force && serialized === lastSerialized) return;

    syncBusy = true;
    setSyncStatus('syncing', 'جارٍ الحفظ');
    try {
      const { data, error } = await db.from('user_state')
        .upsert({ user_id: user.id, data: state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
        .select('updated_at').single();
      if (error) throw error;
      lastSerialized = serialized;
      lastCloudUpdate = data?.updated_at || new Date().toISOString();
      setSyncStatus('synced', 'تم الحفظ');
    } catch (error) {
      console.error('Sync error', error);
      setSyncStatus('error', 'تعذر الحفظ');
    } finally {
      syncBusy = false;
    }
  }

  function startSync() {
    stopSync();
    syncTimer = window.setInterval(() => syncNow(false), Math.max(1000, Number(cfg.CLOUD_SYNC_INTERVAL_MS) || 2000));
  }

  function stopSync() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
  }

  function subscribeRealtime() {
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    realtimeChannel = db.channel(`state-${user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_state', filter: `user_id=eq.${user.id}` }, payload => {
        const remoteTime = payload.new?.updated_at || '';
        if (!payload.new?.data || !remoteTime || remoteTime <= lastCloudUpdate || syncBusy) return;
        const localNow = JSON.stringify(buildState());
        if (localNow !== lastSerialized) return; // لا نستبدل تغييرًا محليًا غير محفوظ.
        applyState(payload.new.data);
        lastSerialized = JSON.stringify(buildState());
        lastCloudUpdate = remoteTime;
        setSyncStatus('synced', 'تم التحديث');
      }).subscribe();
  }

  async function askAI(message, history = []) {
    if (!db || !session) throw new Error('سجّل الدخول لاستخدام المساعد الذكي.');
    const provider = $('aiProvider')?.value || 'auto';
    const { data, error } = await db.functions.invoke(cfg.AI_FUNCTION_NAME || 'ai-chat', {
      body: {
        message: String(message).slice(0, 1500),
        provider,
        history: history.slice(-8).map(item => ({ role: item.role, content: String(item.content).slice(0, 1500) })),
        context: { grade: profile?.grade || '', name: profile?.name || '' }
      }
    });
    if (error) throw new Error(error.context?.status === 429 ? 'وصلت للحد المؤقت. حاول بعد قليل.' : (error.message || 'تعذر الاتصال بالمساعد.'));
    if (!data?.answer) throw new Error(data?.error || 'لم يصل رد من المساعد.');
    return { answer: String(data.answer), provider: data.provider || provider };
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
    try { return await navigator.serviceWorker.register('./sw.js', { scope: './' }); }
    catch (error) { console.warn('Service worker:', error); return null; }
  }

  function base64UrlToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
  }

  async function enableNotifications() {
    if (!('Notification' in window) || !('PushManager' in window)) {
      toast('هذا المتصفح لا يدعم إشعارات الويب');
      return;
    }
    if (!cfg.VAPID_PUBLIC_KEY || cfg.VAPID_PUBLIC_KEY.includes('YOUR_')) {
      toast('أضف VAPID_PUBLIC_KEY في js/config.js أولًا');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      renderPermission();
      toast('لم يتم السماح بالإشعارات');
      return;
    }
    const registration = await registerServiceWorker();
    if (!registration) return toast('تعذر تشغيل خدمة الإشعارات');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(cfg.VAPID_PUBLIC_KEY)
      });
    }
    const json = subscription.toJSON();
    const { error } = await db.from('push_subscriptions').upsert({
      user_id: user.id,
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      user_agent: navigator.userAgent.slice(0, 500),
      updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    renderPermission();
    toast('تم تفعيل الإشعارات 🔔');
  }

  function renderPermission() {
    const box = $('notificationPermission');
    if (!box) return;
    const granted = 'Notification' in window && Notification.permission === 'granted';
    box.innerHTML = granted
      ? '<div class="pi">✅</div><p><b>الإشعارات مفعّلة</b><br>ستصلك التذكيرات حتى عند إغلاق التطبيق بعد إعداد وظيفة الإرسال المجدولة.</p>'
      : '<div class="pi">🔔</div><p><b>فعّل الإشعارات</b><br>حتى نذكّرك بالمهام والاختبارات في وقتها.</p><button onclick="SahhelhaCloud.enableNotifications()">تفعيل</button>';
  }

  async function createReminder(title, scheduledAt, body = '') {
    if (!user) throw new Error('سجّل الدخول أولًا');
    const payload = {
      user_id: user.id,
      title: String(title).trim().slice(0, 100),
      body: String(body || '').trim().slice(0, 300),
      scheduled_at: scheduledAt instanceof Date ? scheduledAt.toISOString() : new Date(scheduledAt).toISOString(),
      status: 'pending'
    };
    const { error } = await db.from('reminders').insert(payload);
    if (error) throw error;
    await listReminders();
  }

  async function createReminderFromForm() {
    const title = ($('reminderTitle')?.value || '').trim();
    const date = $('reminderDate')?.value;
    const time = $('reminderTime')?.value;
    const body = ($('reminderBody')?.value || '').trim();
    if (!title || !date || !time) return toast('أكمل عنوان التذكير وموعده');
    const when = new Date(`${date}T${time}:00`);
    if (!Number.isFinite(when.getTime()) || when <= new Date()) return toast('اختر موعدًا مستقبليًا');
    try {
      await createReminder(title, when, body);
      $('reminderTitle').value = '';
      $('reminderBody').value = '';
      toast('تم حفظ التذكير 🔔');
    } catch (error) { toast(`تعذر الحفظ: ${error.message}`); }
  }

  async function createExamReminder(subject, date) {
    if (!user || !date) return;
    const when = new Date(`${date}T18:00:00`);
    when.setDate(when.getDate() - 1);
    if (when <= new Date()) return;
    try { await createReminder(`اختبار ${subject} غدًا`, when, 'راجع ملخصاتك وحل أسئلة تدريبية.'); }
    catch (error) { console.warn('Exam reminder:', error); }
  }

  async function listReminders() {
    const list = $('remindersList');
    if (!list || !user) return;
    list.innerHTML = '<div class="reminder-empty">جارٍ التحميل…</div>';
    const { data, error } = await db.from('reminders').select('id,title,body,scheduled_at,status,sent_at').eq('user_id', user.id).gte('scheduled_at', new Date(Date.now() - 86400000).toISOString()).order('scheduled_at').limit(50);
    if (error) {
      list.innerHTML = '<div class="reminder-empty">تعذر تحميل التذكيرات</div>';
      return;
    }
    if (!data?.length) {
      list.innerHTML = '<div class="reminder-empty">🔕<br>لا توجد تذكيرات قادمة</div>';
      return;
    }
    list.innerHTML = '';
    for (const item of data) {
      const when = new Date(item.scheduled_at);
      const row = document.createElement('div');
      row.className = 'reminder-item';
      const time = document.createElement('div');
      time.className = 'reminder-time';
      time.textContent = `${when.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' })}\n${when.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}`;
      time.style.whiteSpace = 'pre-line';
      const content = document.createElement('div');
      content.className = 'reminder-body';
      const h = document.createElement('h4'); h.textContent = item.title;
      const p = document.createElement('p'); p.textContent = item.sent_at ? 'تم الإرسال' : (item.body || 'بانتظار الموعد');
      content.append(h, p);
      const del = document.createElement('button');
      del.className = 'icon-delete'; del.textContent = '🗑️'; del.setAttribute('aria-label', 'حذف');
      del.onclick = () => deleteReminder(item.id);
      row.append(time, content, del);
      list.append(row);
    }
  }

  async function deleteReminder(id) {
    const { error } = await db.from('reminders').delete().eq('id', id).eq('user_id', user.id);
    if (error) return toast('تعذر حذف التذكير');
    await listReminders();
  }

  async function signOut() {
    if (!db) return;
    try {
      const registration = await navigator.serviceWorker?.ready;
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        await db.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
        await subscription.unsubscribe();
      }
    } catch {}
    await syncNow(true);
    stopSync();
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    await db.auth.signOut();
    SecureStorage.clear();
    localStorage.removeItem('SAHHELHA_LAST_USER');
    location.reload();
  }

  async function deleteAccount() {
    const confirmation = prompt('لحذف الحساب نهائيًا اكتب: حذف حسابي');
    if (confirmation !== 'حذف حسابي') return;
    const { data, error } = await db.functions.invoke(cfg.DELETE_ACCOUNT_FUNCTION_NAME || 'delete-account', { body: { confirm: true } });
    if (error || !data?.ok) return toast('تعذر حذف الحساب. حاول لاحقًا.');
    SecureStorage.clear();
    localStorage.removeItem('SAHHELHA_LAST_USER');
    localStorage.removeItem('SAHHELHA_VISITOR_ID');
    alert('تم حذف حسابك وبياناتك.');
    location.reload();
  }

  async function installApp() {
    if (!installPrompt) return toast('من قائمة المتصفح اختر «إضافة إلى الشاشة الرئيسية»');
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    if ($('installAppBtn')) $('installAppBtn').hidden = true;
  }

  function openAccount() {
    try { oP('account'); } catch {}
    updateAccountUi();
  }

  function handleRequestedPanel() {
    const panel = new URLSearchParams(location.search).get('open');
    if (panel && ['chat', 'tasks', 'reminders', 'lib', 'exams'].includes(panel)) setTimeout(() => oP(panel), 250);
  }

  function wireUi() {
    $('authForm')?.addEventListener('submit', submitAuth);
    document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
    $('googleLogin')?.addEventListener('click', googleLogin);
    $('forgotPassword')?.addEventListener('click', forgotPassword);
    $('localMode')?.addEventListener('click', () => {
      if (!cfg.ALLOW_LOCAL_MODE) return;
      hideGate(); showStudentApp(); renderCore();
    });
    $('enableNotificationsBtn')?.addEventListener('click', enableNotifications);
    $('saveReminderBtn')?.addEventListener('click', createReminderFromForm);
    $('logoutBtn')?.addEventListener('click', signOut);
    $('deleteAccountBtn')?.addEventListener('click', deleteAccount);
    $('installAppBtn')?.addEventListener('click', installApp);

    window.addEventListener('online', () => { setSyncStatus('syncing', 'جارٍ الاتصال'); syncNow(true); });
    window.addEventListener('offline', () => setSyncStatus('offline', 'دون اتصال'));
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); installPrompt = event;
      if ($('installAppBtn')) $('installAppBtn').hidden = false;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') syncNow(false);
      else if (document.visibilityState === 'visible') { syncNow(false); listReminders(); trackVisit(false); }
    });
  }

  async function initialize() {
    wireUi();
    setAuthMode('login');
    if (!configured || !window.supabase?.createClient) {
      showSetupError();
      if (cfg.ALLOW_LOCAL_MODE && $('localMode')) $('localMode').hidden = false;
      return;
    }

    db = window.supabase.createClient(cfg.SUPABASE_URL.replace(/\/$/, ''), cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 5 } }
    });
    startVisitorTracking();
    await configureAuthProviders();

    const { data, error } = await db.auth.getSession();
    if (error) showStatus(authErrorMessage(error), 'error');
    if (data?.session) await bootstrap(data.session);
    else showGate();

    db.auth.onAuthStateChange((event, nextSession) => {
      session = nextSession;
      if (event === 'SIGNED_IN' && nextSession) setTimeout(() => bootstrap(nextSession), 0);
      if (event === 'SIGNED_OUT') {
        cloudReady = false;
        stopSync();
        if (realtimeChannel) db.removeChannel(realtimeChannel);
        try { SecureStorage.clear(); } catch {}
        localStorage.removeItem('SAHHELHA_LAST_USER');
        if ($('app')) $('app').style.display = 'none';
        bootingUserId = null; user = null; profile = null;
        showGate();
      }
      if (event === 'PASSWORD_RECOVERY') {
        const password = prompt('اكتب كلمة المرور الجديدة (8 أحرف على الأقل):');
        if (password && password.length >= 8) db.auth.updateUser({ password }).then(({ error }) => {
          showStatus(error ? authErrorMessage(error) : 'تم تحديث كلمة المرور.', error ? 'error' : 'ok');
        });
      }
    });
  }

  window.SahhelhaCloud = {
    get client() { return db; },
    get user() { return user; },
    get profile() { return profile; },
    get ready() { return cloudReady; },
    askAI,
    saveProfile,
    completeOnboarding: (name, grade) => saveProfile(name, grade).catch(error => toast(`تعذر حفظ الملف: ${error.message}`)),
    syncNow,
    enableNotifications,
    createReminderFromForm,
    createExamReminder,
    listReminders,
    deleteReminder,
    openAccount,
    signOut,
    deleteAccount,
    installApp
  };

  initialize().catch(error => {
    console.error(error);
    showGate();
    showStatus(`تعذر تشغيل التطبيق: ${error.message}`, 'error');
  });
})();

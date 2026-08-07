/* لوحة إدارة محتوى سَهِّلها */
'use strict';

(() => {
  const cfg = window.SAHHELHA_CONFIG || {};
  const $ = id => document.getElementById(id);
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.SUPABASE_URL || '') &&
    typeof cfg.SUPABASE_ANON_KEY === 'string' && cfg.SUPABASE_ANON_KEY.length > 40 && !cfg.SUPABASE_ANON_KEY.includes('YOUR_');
  let db, user;
  const state = { subjects: [], questions: [], cards: [], resources: [] };

  function guard(title, message, action = true) {
    $('guardTitle').textContent = title;
    $('guardMessage').textContent = message;
    $('guardAction').style.display = action ? 'inline-block' : 'none';
    $('adminGuard').classList.remove('hidden');
  }

  function toast(message) {
    const box = $('adminToast');
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => box.classList.remove('show'), 2600);
  }

  function text(value, max = 300) { return String(value ?? '').trim().slice(0, max); }
  function gradeLabel(value) { return ({ '1high': 'أول ثانوي', '2high': 'ثاني ثانوي', '3high': 'ثالث ثانوي' })[value] || value; }
  function semesterLabel(value) { return value === 's1' ? 'الفصل الأول' : 'الفصل الثاني'; }
  function setLoading(form, value) { form.classList.toggle('loading', value); Array.from(form.elements).forEach(el => el.disabled = value); }

  function createRecord({ icon, title, subtitle, active, onEdit, onDelete }) {
    const row = document.createElement('article'); row.className = 'record';
    const ico = document.createElement('div'); ico.className = 'record-icon'; ico.textContent = icon;
    const body = document.createElement('div'); body.className = 'record-body';
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = subtitle;
    const badge = document.createElement('span'); badge.className = `badge${active ? '' : ' off'}`; badge.textContent = active ? 'منشور' : 'مخفي';
    body.append(h, p, badge);
    const actions = document.createElement('div'); actions.className = 'record-actions';
    const edit = document.createElement('button'); edit.className = 'secondary small-btn'; edit.type = 'button'; edit.textContent = 'تعديل'; edit.onclick = onEdit;
    const del = document.createElement('button'); del.className = 'danger small-btn'; del.type = 'button'; del.textContent = 'حذف'; del.onclick = onDelete;
    actions.append(edit, del); row.append(ico, body, actions); return row;
  }

  function empty(list, message) {
    list.innerHTML = '';
    const div = document.createElement('div'); div.className = 'empty-admin'; div.textContent = message; list.appendChild(div);
  }

  function renderSubjects() {
    const query = text($('subjectSearch').value).toLowerCase();
    const rows = state.subjects.filter(row => `${row.name} ${row.code} ${row.grade_label}`.toLowerCase().includes(query));
    const list = $('subjectList'); list.innerHTML = '';
    if (!rows.length) return empty(list, 'لا توجد مواد مطابقة');
    rows.forEach(row => list.appendChild(createRecord({
      icon: row.icon || '📘', title: row.name,
      subtitle: `${row.code} • ${row.grade_label} • ${row.semester_label}`,
      active: row.active, onEdit: () => editSubject(row.id), onDelete: () => removeRow('subjects', row.id, row.name)
    })));
  }

  function renderQuestions() {
    const query = text($('questionSearch').value).toLowerCase();
    const rows = state.questions.filter(row => `${row.question} ${row.category_label}`.toLowerCase().includes(query));
    const list = $('questionList'); list.innerHTML = '';
    if (!rows.length) return empty(list, 'لا توجد أسئلة مطابقة');
    rows.forEach(row => list.appendChild(createRecord({
      icon: '❓', title: row.question,
      subtitle: `${row.category_label} • الإجابة ${Number(row.correct_index) + 1}`,
      active: row.active, onEdit: () => editQuestion(row.id), onDelete: () => removeRow('questions', row.id, 'السؤال')
    })));
  }

  function renderCards() {
    const query = text($('cardSearch').value).toLowerCase();
    const rows = state.cards.filter(row => `${row.question} ${row.answer} ${row.category_label}`.toLowerCase().includes(query));
    const list = $('cardList'); list.innerHTML = '';
    if (!rows.length) return empty(list, 'لا توجد بطاقات مطابقة');
    rows.forEach(row => list.appendChild(createRecord({
      icon: '🃏', title: row.question,
      subtitle: `${row.category_label} • ${row.answer}`,
      active: row.active, onEdit: () => editCard(row.id), onDelete: () => removeRow('flashcards', row.id, 'البطاقة')
    })));
  }

  function renderResources() {
    const query = text($('resourceSearch').value).toLowerCase();
    const subjectMap = new Map(state.subjects.map(row => [row.id, row.name]));
    const rows = state.resources.filter(row => `${row.title} ${row.description} ${subjectMap.get(row.subject_id) || ''}`.toLowerCase().includes(query));
    const list = $('resourceList'); list.innerHTML = '';
    if (!rows.length) return empty(list, 'لا توجد موارد مطابقة');
    rows.forEach(row => list.appendChild(createRecord({
      icon: row.resource_type === 'video' ? '🎬' : row.resource_type === 'book' ? '📚' : '📎',
      title: row.title, subtitle: `${subjectMap.get(row.subject_id) || 'مادة محذوفة'} • ${row.resource_type}`,
      active: row.active, onEdit: () => editResource(row.id), onDelete: () => removeResource(row.id, row.title)
    })));
  }

  function updateStats() {
    $('statSubjects').textContent = state.subjects.length;
    $('statQuestions').textContent = state.questions.length;
    $('statCards').textContent = state.cards.length;
    $('statResources').textContent = state.resources.length;
  }

  function fillSubjectOptions() {
    const select = $('resourceSubject'); const value = select.value;
    select.innerHTML = '<option value="">اختر المادة</option>';
    state.subjects.forEach(row => {
      const option = document.createElement('option'); option.value = row.id; option.textContent = `${row.icon || '📘'} ${row.name}`; select.appendChild(option);
    });
    if ([...select.options].some(option => option.value === value)) select.value = value;
  }

  async function loadAll() {
    const [subjects, questions, cards, resources] = await Promise.all([
      db.from('subjects').select('*').order('sort_order').order('name'),
      db.from('questions').select('*').order('created_at', { ascending: false }),
      db.from('flashcards').select('*').order('created_at', { ascending: false }),
      db.from('resources').select('*').order('sort_order').order('created_at', { ascending: false })
    ]);
    for (const result of [subjects, questions, cards, resources]) if (result.error) throw result.error;
    state.subjects = subjects.data || [];
    state.questions = questions.data || [];
    state.cards = cards.data || [];
    state.resources = resources.data || [];
    fillSubjectOptions(); renderSubjects(); renderQuestions(); renderCards(); renderResources(); updateStats();
  }

  function resetForm(kind) {
    const map = { subject: 'subjectForm', question: 'questionForm', card: 'cardForm', resource: 'resourceForm' };
    const form = $(map[kind]); form.reset();
    if (kind === 'subject') { $('subjectId').value = ''; $('subjectIcon').value = '📘'; $('subjectOrder').value = '0'; $('subjectActive').checked = true; $('subjectUnits').value = '[{"name":"الوحدة الأولى","lessons":["الدرس الأول","الدرس الثاني"]}]'; validateUnits(); }
    if (kind === 'question') { $('questionId').value = ''; $('questionCategory').value = 'math'; $('questionCategoryLabel').value = '📗 الرياضيات'; $('questionCorrect').value = '1'; $('questionActive').checked = true; }
    if (kind === 'card') { $('cardId').value = ''; $('cardCategory').value = 'science'; $('cardCategoryLabel').value = '🔬 علوم'; $('cardActive').checked = true; }
    if (kind === 'resource') { $('resourceId').value = ''; $('resourceFilePath').value = ''; $('resourcePublicUrl').value = ''; $('resourceOrder').value = '0'; $('resourceActive').checked = true; }
  }

  function validateUnits() {
    const info = $('unitsValidation');
    try {
      const units = JSON.parse($('subjectUnits').value);
      if (!Array.isArray(units) || units.some(unit => !unit?.name || !Array.isArray(unit.lessons))) throw new Error();
      info.textContent = `صحيح: ${units.length} وحدة`;
      info.className = 'field-hint json-valid'; return units;
    } catch {
      info.textContent = 'صيغة غير صحيحة. يجب أن تكون مصفوفة وحدات، وكل وحدة تحتوي name وlessons.';
      info.className = 'field-hint json-invalid'; return null;
    }
  }

  async function saveSubject(event) {
    event.preventDefault(); const form = event.currentTarget; const units = validateUnits();
    if (!units) return toast('صحح صيغة الوحدات');
    const id = $('subjectId').value;
    const grade = $('subjectGrade').value; const semester = $('subjectSemester').value;
    const payload = {
      code: text($('subjectCode').value, 40), name: text($('subjectName').value, 100), icon: text($('subjectIcon').value || '📘', 8),
      grade, grade_label: gradeLabel(grade), semester, semester_label: semesterLabel(semester), units,
      sort_order: Number($('subjectOrder').value) || 0, active: $('subjectActive').checked, created_by: user.id
    };
    setLoading(form, true);
    const result = id ? await db.from('subjects').update(payload).eq('id', id) : await db.from('subjects').insert(payload);
    setLoading(form, false);
    if (result.error) return toast(`تعذر الحفظ: ${result.error.message}`);
    resetForm('subject'); await loadAll(); toast('تم حفظ المادة');
  }

  async function saveQuestion(event) {
    event.preventDefault(); const form = event.currentTarget; const id = $('questionId').value;
    const options = $('questionOptions').value.split('\n').map(value => text(value, 250)).filter(Boolean);
    const correct = Number($('questionCorrect').value) - 1;
    if (options.length < 2 || correct < 0 || correct >= options.length) return toast('تحقق من الخيارات ورقم الإجابة الصحيحة');
    const payload = {
      category: text($('questionCategory').value, 40), category_label: text($('questionCategoryLabel').value, 80),
      grade: $('questionGrade').value || null, question: text($('questionText').value, 1000), options,
      correct_index: correct, explanation: text($('questionExplanation').value, 1500), active: $('questionActive').checked, created_by: user.id
    };
    setLoading(form, true);
    const result = id ? await db.from('questions').update(payload).eq('id', id) : await db.from('questions').insert(payload);
    setLoading(form, false);
    if (result.error) return toast(`تعذر الحفظ: ${result.error.message}`);
    resetForm('question'); await loadAll(); toast('تم حفظ السؤال');
  }

  async function saveCard(event) {
    event.preventDefault(); const form = event.currentTarget; const id = $('cardId').value;
    const payload = {
      category: text($('cardCategory').value, 40), category_label: text($('cardCategoryLabel').value, 80),
      grade: $('cardGrade').value || null, question: text($('cardQuestion').value, 1000), answer: text($('cardAnswer').value, 2000),
      active: $('cardActive').checked, created_by: user.id
    };
    setLoading(form, true);
    const result = id ? await db.from('flashcards').update(payload).eq('id', id) : await db.from('flashcards').insert(payload);
    setLoading(form, false);
    if (result.error) return toast(`تعذر الحفظ: ${result.error.message}`);
    resetForm('card'); await loadAll(); toast('تم حفظ البطاقة');
  }

  function safeFileName(name) {
    const extension = name.includes('.') ? `.${name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
    return `${crypto.randomUUID()}${extension}`;
  }

  async function uploadResourceFile(file, subjectId) {
    if (file.size > 50 * 1024 * 1024) throw new Error('حجم الملف أكبر من 50MB');
    const path = `${subjectId}/${safeFileName(file.name)}`;
    $('uploadProgress').hidden = false; $('uploadProgress').querySelector('span').style.width = '45%';
    const { error } = await db.storage.from('curriculum').upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });
    if (error) throw error;
    $('uploadProgress').querySelector('span').style.width = '100%';
    const { data } = db.storage.from('curriculum').getPublicUrl(path);
    return { filePath: path, publicUrl: data.publicUrl };
  }

  async function saveResource(event) {
    event.preventDefault(); const form = event.currentTarget; const id = $('resourceId').value;
    const subjectId = $('resourceSubject').value; const file = $('resourceFile').files[0];
    let filePath = $('resourceFilePath').value || null; let publicUrl = $('resourcePublicUrl').value || null;
    const oldPath = filePath;
    setLoading(form, true);
    try {
      if (file) {
        const uploaded = await uploadResourceFile(file, subjectId);
        filePath = uploaded.filePath; publicUrl = uploaded.publicUrl;
      }
      const externalUrl = text($('resourceUrl').value, 1000) || null;
      if (!externalUrl && !filePath && !publicUrl) throw new Error('أضف رابطًا أو ارفع ملفًا');
      const payload = {
        subject_id: subjectId, title: text($('resourceTitle').value, 150), description: text($('resourceDescription').value, 500),
        resource_type: $('resourceType').value, external_url: externalUrl, file_path: filePath, public_url: publicUrl,
        sort_order: Number($('resourceOrder').value) || 0, active: $('resourceActive').checked, created_by: user.id
      };
      const result = id ? await db.from('resources').update(payload).eq('id', id) : await db.from('resources').insert(payload);
      if (result.error) throw result.error;
      if (file && oldPath && oldPath !== filePath) await db.storage.from('curriculum').remove([oldPath]);
      resetForm('resource'); await loadAll(); toast('تم حفظ المورد');
    } catch (error) {
      if (file && filePath && filePath !== oldPath) await db.storage.from('curriculum').remove([filePath]);
      toast(`تعذر الحفظ: ${error.message}`);
    } finally {
      setLoading(form, false); $('uploadProgress').hidden = true; $('uploadProgress').querySelector('span').style.width = '0';
    }
  }

  function editSubject(id) {
    const row = state.subjects.find(item => item.id === id); if (!row) return;
    $('subjectId').value = row.id; $('subjectCode').value = row.code; $('subjectName').value = row.name; $('subjectIcon').value = row.icon;
    $('subjectGrade').value = row.grade; $('subjectSemester').value = row.semester; $('subjectUnits').value = JSON.stringify(row.units, null, 2);
    $('subjectOrder').value = row.sort_order; $('subjectActive').checked = row.active; validateUnits(); scrollTo({ top: 0, behavior: 'smooth' });
  }

  function editQuestion(id) {
    const row = state.questions.find(item => item.id === id); if (!row) return;
    $('questionId').value = row.id; $('questionCategory').value = row.category; $('questionCategoryLabel').value = row.category_label;
    $('questionText').value = row.question; $('questionOptions').value = (row.options || []).join('\n'); $('questionCorrect').value = Number(row.correct_index) + 1;
    $('questionGrade').value = row.grade || ''; $('questionExplanation').value = row.explanation || ''; $('questionActive').checked = row.active; scrollTo({ top: 0, behavior: 'smooth' });
  }

  function editCard(id) {
    const row = state.cards.find(item => item.id === id); if (!row) return;
    $('cardId').value = row.id; $('cardCategory').value = row.category; $('cardCategoryLabel').value = row.category_label;
    $('cardQuestion').value = row.question; $('cardAnswer').value = row.answer; $('cardGrade').value = row.grade || ''; $('cardActive').checked = row.active; scrollTo({ top: 0, behavior: 'smooth' });
  }

  function editResource(id) {
    const row = state.resources.find(item => item.id === id); if (!row) return;
    $('resourceId').value = row.id; $('resourceSubject').value = row.subject_id; $('resourceTitle').value = row.title;
    $('resourceType').value = row.resource_type; $('resourceDescription').value = row.description || ''; $('resourceUrl').value = row.external_url || '';
    $('resourceFilePath').value = row.file_path || ''; $('resourcePublicUrl').value = row.public_url || ''; $('resourceOrder').value = row.sort_order; $('resourceActive').checked = row.active; scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function removeRow(table, id, label) {
    if (!confirm(`حذف «${label}»؟ لا يمكن التراجع.`)) return;
    const linked = table === 'subjects'
      ? state.resources.filter(item => item.subject_id === id && item.file_path).map(item => item.file_path)
      : [];
    const { error } = await db.from(table).delete().eq('id', id);
    if (error) return toast(`تعذر الحذف: ${error.message}`);
    if (linked.length) await db.storage.from('curriculum').remove(linked);
    await loadAll(); toast('تم الحذف');
  }

  async function removeResource(id, label) {
    if (!confirm(`حذف المورد «${label}»؟`)) return;
    const row = state.resources.find(item => item.id === id);
    const { error } = await db.from('resources').delete().eq('id', id);
    if (error) return toast(`تعذر الحذف: ${error.message}`);
    if (row?.file_path) await db.storage.from('curriculum').remove([row.file_path]);
    await loadAll(); toast('تم حذف المورد');
  }

  function wireUi() {
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
      document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${tab.dataset.panel}`));
    }));
    $('subjectForm').addEventListener('submit', saveSubject); $('questionForm').addEventListener('submit', saveQuestion);
    $('cardForm').addEventListener('submit', saveCard); $('resourceForm').addEventListener('submit', saveResource);
    document.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', () => resetForm(button.dataset.reset)));
    $('subjectUnits').addEventListener('input', validateUnits);
    $('subjectSearch').addEventListener('input', renderSubjects); $('questionSearch').addEventListener('input', renderQuestions);
    $('cardSearch').addEventListener('input', renderCards); $('resourceSearch').addEventListener('input', renderResources);
    $('adminLogout').addEventListener('click', async () => { await db.auth.signOut(); location.href = './'; });
  }

  async function init() {
    wireUi(); validateUnits();
    if (!configured || !window.supabase?.createClient) return guard('الإعداد غير مكتمل', 'أدخل SUPABASE_URL والمفتاح العام في js/config.js.');
    db = window.supabase.createClient(cfg.SUPABASE_URL.replace(/\/$/, ''), cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await db.auth.getSession();
    if (!data.session?.user) return guard('سجّل الدخول أولًا', 'افتح التطبيق وسجّل الدخول بحساب المدير.');
    user = data.session.user;
    const { data: profile, error } = await db.from('profiles').select('name,email,role').eq('id', user.id).single();
    if (error || profile?.role !== 'admin') return guard('غير مصرح', 'هذا الحساب ليس مديرًا. غيّر role إلى admin من Supabase SQL Editor.');
    $('adminIdentity').textContent = `${profile.name || 'المدير'} • ${profile.email || user.email}`;
    try { await loadAll(); $('adminGuard').classList.add('hidden'); }
    catch (loadError) { guard('تعذر تحميل المحتوى', `${loadError.message}. تأكد من تنفيذ schema.sql.`); }
  }

  init().catch(error => guard('حدث خطأ', error.message));
})();

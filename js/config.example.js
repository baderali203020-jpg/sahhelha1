/*
 * إعدادات عامة فقط — لا تضع هنا أي مفتاح سري.
 * انسخ هذا الملف إلى config.js ثم أدخل بيانات مشروع Supabase.
 */
window.SAHHELHA_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY',

  // اتركه فارغًا ليُكتشف الرابط تلقائيًا، أو ضع https://sahhilha.com
  SITE_URL: '',

  // المفتاح العام فقط. المفتاح الخاص يُحفظ في أسرار Supabase Edge Functions.
  VAPID_PUBLIC_KEY: '',

  AI_FUNCTION_NAME: 'ai-chat',
  REMINDERS_FUNCTION_NAME: 'send-reminders',
  DELETE_ACCOUNT_FUNCTION_NAME: 'delete-account',
  CLOUD_SYNC_INTERVAL_MS: 2000,
  ALLOW_LOCAL_MODE: false
};

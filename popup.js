const SUPABASE_URL = 'https://erhalnpgzttnhiilopcp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-Gi3ASdyuqDCisD_jCweqQ_oFP4qIQG';

// Initialize Supabase
let supabase;

async function checkAuth() {
  const authSection = document.getElementById('auth-section');
  const mainSection = document.getElementById('main-section');
  const userDisplay = document.getElementById('user-display');
  
  // Try to find session in background script or common storage
  const { session } = await chrome.storage.local.get('session');
  
  if (session && session.user) {
    authSection.classList.add('hidden');
    mainSection.classList.remove('hidden');
    userDisplay.textContent = `Connecté: ${session.user.email}`;
    return session;
  } else {
    authSection.classList.remove('hidden');
    mainSection.classList.add('hidden');
    return null;
  }
}

document.getElementById('login-btn').addEventListener('click', () => {
  // Opening the web app to allow the user to log in and then sync the session back
  chrome.tabs.create({ url: 'https://job-tracker-opal-ten.vercel.app/login' });
});

// Utility to reset UI state no matter what
function resetUI() {
  const btn = document.getElementById('scrape-btn');
  const loader = document.getElementById('btn-loader');
  const text = document.getElementById('btn-text');
  if (btn) btn.disabled = false;
  if (loader) loader.classList.add('hidden');
  if (text && text.textContent.includes('...')) {
    text.textContent = 'Réessayer';
  }
}

// Status Selector logic
let currentStatus = 'applied';
const statusSelector = document.getElementById('status-selector');
if (statusSelector) {
  statusSelector.addEventListener('click', (e) => {
    const option = e.target.closest('.status-option');
    if (!option) return;
    document.querySelectorAll('.status-option').forEach(el => el.classList.remove('active'));
    option.classList.add('active');
    currentStatus = option.dataset.status;
  });
}

document.getElementById('scrape-btn').addEventListener('click', async () => {
  const btn = document.getElementById('scrape-btn');
  const text = document.getElementById('btn-text');
  const loader = document.getElementById('btn-loader');
  const message = document.getElementById('message');
  
  if (!btn || !text || !loader) return;

  // Failsafe: stop spinning after 15s guaranteed
  const failsafe = setTimeout(() => {
    console.error('Failsafe triggered');
    resetUI();
    if (message) message.textContent = 'Délai dépassé. Vérifiez votre connexion.';
  }, 15000);

  btn.disabled = true;
  loader.classList.remove('hidden');
  text.textContent = 'Initialisation...';
  message.textContent = '';
  
  try {
    // 1. Get current tab
    text.textContent = 'Lecture page (1/4)...';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('Onglet introuvable');
    
    // 2. Scrape with local timeout
    const scrapePromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => ({
        title: document.title,
        url: window.location.href,
        content: document.body.innerText.substring(0, 5000)
      })
    });
    
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Page trop lente')), 5000));
    const result = await Promise.race([scrapePromise, timeoutPromise]).catch(e => {
        console.warn('Scraping fallback:', e);
        return [{ result: { title: tab.title || "Sans titre", url: tab.url || "", content: "" } }];
    });
    
    const scrapeData = result[0].result;
    
    // 3. Auth
    text.textContent = 'Connexion (2/4)...';
    const { session } = await chrome.storage.local.get('session');
    if (!session || !session.access_token) throw new Error('Veuillez vous connecter sur le site JobTracker d\'abord.');

    const client = self.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    await client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token || ''
    });

    // 4. AI Analysis
    text.textContent = 'Analyse IA (3/4)...';
    let aiData = null;
    try {
      const aiPromise = client.functions.invoke('analyze-job', {
        body: { text: scrapeData.content }
      });
      const aiTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('IA Timeout')), 7000));
      
      const { data, error: aiError } = await Promise.race([aiPromise, aiTimeout]);
      if (aiError) throw aiError;
      aiData = data;
    } catch (e) {
      console.warn('IA bypass:', e.message);
      const parts = scrapeData.title.split(/ [|—-] /);
      aiData = {
        company_name: parts[1]?.trim() || parts[0]?.trim() || 'Inconnue',
        job_profile: parts[0]?.trim() || 'Poste'
      };
    }

    // 5. DB Insert
    text.textContent = 'Sauvegarde (4/4)...';
    const { error: dbError } = await client
      .from('job_applications')
      .insert([{ 
        user_id: session.user.id,
        company_name: aiData.company_name,
        job_profile: aiData.job_profile,
        url: scrapeData.url,
        status: currentStatus,
        applied_at: currentStatus === 'applied' ? new Date().toISOString() : null,
        proposed_salary: aiData.proposed_salary || '',
        primary_skills: aiData.primary_skills || '',
        company_info: aiData.company_info || '',
        main_missions: aiData.main_missions || `Analysé le ${new Date().toLocaleDateString()}\n\nTexte source:\n${scrapeData.content}`
      }]);

    if (dbError) throw dbError;

    text.textContent = 'Enregistré !';
    message.textContent = 'Offre ajoutée avec succès !';
    message.className = 'success';
    clearTimeout(failsafe);
    setTimeout(() => {
       loader.classList.add('hidden');
       btn.disabled = false;
    }, 1000);

  } catch (err) {
    console.error('Crash extension:', err);
    clearTimeout(failsafe);
    message.textContent = `Erreur: ${err.message}`;
    message.className = 'error';
    resetUI();
  }
});

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const tabs = await chrome.tabs.query({ url: '*://job-tracker-opal-ten.vercel.app/*' });
    if (tabs.length > 0) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        function: () => localStorage.getItem('sb-erhalnpgzttnhiilopcp-auth-token')
      }).catch(() => []);
      
      const raw = res[0]?.result;
      if (raw) await chrome.storage.local.set({ session: JSON.parse(raw) });
    }
  } catch (e) {}
  checkAuth();
});





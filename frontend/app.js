(function () {
  'use strict';

  var API_BASE = '';
  var INTENDED_VIEW_KEY = 'workedwith_intended_view';
  var SIGNUP_PASSWORD_KEY = 'workedwith_signup_password_set';
  var sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  function initials(n) {
    return (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function card(p, company) {
    var lc = company.trim().toLowerCase();
    var match = p.clients.find(function (c) { return c.company.trim().toLowerCase() === lc; });
    return {
      name: p.name, employer: p.employer, title: p.title, desc: p.desc,
      initials: initials(p.name),
      matchCompany: match ? match.company : ''
    };
  }

  function apiFetch(path, options) {
    return fetch(API_BASE + path, options).catch(function () {
      throw new Error('Couldn’t reach the server. Is the backend running?');
    });
  }

  function parseJson(res) {
    return res.json().then(function (data) { return { ok: res.ok, data: data }; });
  }

  function authHeaders(extra) {
    var headers = Object.assign({}, extra || {});
    if (state.sbToken) headers.Authorization = 'Bearer ' + state.sbToken;
    return headers;
  }

  var state = {
    view: 'landing',
    me: { name: '', employer: '', title: '', desc: '', clients: [], hasPassword: false },
    sbToken: null, sbEmail: null,
    recruiterChecked: false, professionalLoaded: false,
    candidateLoggedIn: false, candidateStage: 'password', candidateEmail: '',
    newCo: '', previewIdx: 0,
    email: '', recStage: 'password', recHasPassword: false,
    recCompany: null, selectedId: null, matches: [],
    threadForId: null, threadMessages: [],
    conversations: [], convSelectedId: null, convThreadForId: null, convThreadMessages: [],
    passwordSetupDismissedCand: false, passwordSetupDismissedRec: false,
    justSetPasswordAtSignup: false, authChecked: false,
    professionalCheckDone: false, recruiterCheckDone: false
  };

  var el = {};
  ['logo-btn', 'tab-candidate', 'tab-recruiter', 'card-candidate', 'card-recruiter',
    'view-landing', 'view-candidate', 'view-recruiter-unverified', 'view-recruiter-verified',
    'candidate-gate', 'candidate-content',
    'candidate-stage-password', 'candidate-stage-signup', 'candidate-stage-email', 'candidate-stage-sent',
    'cand-login-email', 'cand-login-password', 'cand-login-error', 'cand-login-btn',
    'cand-goto-signup-btn', 'cand-use-link-btn',
    'cand-signup-email', 'cand-signup-password', 'cand-signup-error', 'cand-signup-btn', 'cand-signup-back-to-password-btn',
    'cand-email', 'cand-email-error', 'cand-verify-btn', 'cand-back-to-password-btn',
    'cand-sent-email', 'cand-back-to-email-btn',
    'candidate-signed-in-as', 'candidate-sign-out-btn',
    'candidate-account-trigger', 'candidate-account-dropdown',
    'candidate-password-setup', 'cand-new-password', 'cand-save-password-btn', 'cand-skip-password-btn', 'cand-password-error',
    'me-name', 'me-employer', 'me-title', 'me-desc',
    'client-rows', 'new-co', 'add-client-btn',
    'resume-status', 'resume-view-link', 'resume-file-input', 'resume-upload-btn', 'resume-error',
    'preview-chips', 'preview-area',
    'conv-list', 'conv-detail-panel',
    'resume-modal', 'resume-modal-backdrop', 'resume-modal-title', 'resume-modal-close', 'resume-modal-frame',
    'verify-stage-password', 'verify-stage-signup', 'verify-stage-email', 'verify-stage-sent',
    'rec-login-email', 'rec-login-password', 'rec-login-error', 'rec-login-btn',
    'rec-goto-signup-btn', 'rec-use-link-btn',
    'rec-signup-email', 'rec-signup-password', 'rec-signup-error', 'rec-signup-btn', 'rec-signup-back-to-password-btn',
    'rec-email', 'email-error', 'verify-btn', 'rec-back-to-password-btn',
    'rec-sent-email', 'back-to-email-btn',
    'results-heading', 'results-count', 'results-email', 'sign-out-btn',
    'recruiter-account-trigger', 'recruiter-account-dropdown',
    'rec-password-setup', 'rec-new-password', 'rec-save-password-btn', 'rec-skip-password-btn', 'rec-password-error',
    'matches-list', 'detail-panel'
  ].forEach(function (id) { el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id); });

  function goTo(view) {
    state.view = view;
    renderShell();
  }

  function renderShell() {
    // Kick off the lazy profile/recruiter checks as soon as we have a token for
    // this view. Safe to call on every render: these guards only let the
    // underlying fetch fire once, so re-running this is a no-op once in flight.
    if (state.view === 'candidate' && state.sbToken && !state.candidateLoggedIn && !state.professionalLoaded) {
      state.professionalLoaded = true;
      loadProfessionalProfile();
    }
    if (state.view === 'recruiter' && state.sbToken && !state.recCompany && !state.recruiterChecked) {
      state.recruiterChecked = true;
      loadOrFinalizeRecruiter();
    }

    // Until we know for sure whether this person is already signed in -- and,
    // if so, until our own backend has confirmed their profile/recruiter
    // status -- never show the login gate. Otherwise it flashes on screen and
    // then gets silently replaced once the check resolves, which looks exactly
    // like "I typed my email and got logged in with no password."
    var checkingCandidate = state.view === 'candidate' && state.sbToken && !state.professionalCheckDone;
    var checkingRecruiter = state.view === 'recruiter' && state.sbToken && !state.recruiterCheckDone;
    var waitingOnAuthCheck = (state.view === 'candidate' || state.view === 'recruiter') &&
      (!state.authChecked || checkingCandidate || checkingRecruiter);
    document.getElementById('view-loading').classList.toggle('active', waitingOnAuthCheck);
    document.getElementById('view-landing').classList.toggle('active', !waitingOnAuthCheck && state.view === 'landing');
    document.getElementById('view-candidate').classList.toggle('active', !waitingOnAuthCheck && state.view === 'candidate');
    var recruiterUnverified = !waitingOnAuthCheck && state.view === 'recruiter' && !state.recCompany;
    var recruiterVerified = !waitingOnAuthCheck && state.view === 'recruiter' && !!state.recCompany;
    document.getElementById('view-recruiter-unverified').classList.toggle('active', recruiterUnverified);
    document.getElementById('view-recruiter-verified').classList.toggle('active', recruiterVerified);
    el.tabCandidate.classList.toggle('active', state.view === 'candidate');
    el.tabRecruiter.classList.toggle('active', state.view === 'recruiter');

    if (waitingOnAuthCheck) return;

    el.candidateGate.hidden = state.candidateLoggedIn;
    el.candidateContent.hidden = !state.candidateLoggedIn;
    el.candidateStagePassword.hidden = state.candidateStage !== 'password';
    el.candidateStageSignup.hidden = state.candidateStage !== 'signup';
    el.candidateStageEmail.hidden = state.candidateStage !== 'email';
    el.candidateStageSent.hidden = state.candidateStage !== 'sent';
    if (state.candidateLoggedIn) el.candidateSignedInAs.textContent = 'Signed in as ' + state.candidateEmail;
    el.candidatePasswordSetup.hidden = !(state.candidateLoggedIn && !state.me.hasPassword && !state.passwordSetupDismissedCand);

    el.verifyStagePassword.hidden = state.recStage !== 'password';
    el.verifyStageSignup.hidden = state.recStage !== 'signup';
    el.verifyStageEmail.hidden = state.recStage !== 'email';
    el.verifyStageSent.hidden = state.recStage !== 'sent';
    el.recPasswordSetup.hidden = !(recruiterVerified && !state.recHasPassword && !state.passwordSetupDismissedRec);

    if (recruiterVerified) loadAndRenderResults();
  }

  // ---- Candidate: profile rendering ----
  function syncCandidateForm() {
    el.meName.value = state.me.name;
    el.meEmployer.value = state.me.employer;
    el.meTitle.value = state.me.title;
    el.meDesc.value = state.me.desc;
  }

  function renderClientRows() {
    el.clientRows.innerHTML = state.me.clients.map(function (c) {
      return '<div class="client-row">' +
        '<span class="client-row-initial">' + esc((c.company[0] || '?').toUpperCase()) + '</span>' +
        '<div class="client-row-body"><span class="client-row-company">' + esc(c.company) + '</span></div>' +
        '<button class="client-row-remove" type="button" data-id="' + c.id + '">Remove</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(el.clientRows.querySelectorAll('.client-row-remove'), function (btn) {
      btn.addEventListener('click', function () { removeClient(Number(btn.getAttribute('data-id'))); });
    });
  }

  function renderPreviewChips() {
    el.previewChips.innerHTML = state.me.clients.map(function (c, i) {
      var active = i === state.previewIdx;
      return '<button class="chip' + (active ? ' active' : '') + '" type="button" data-idx="' + i + '">' + esc(c.company) + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.previewChips.querySelectorAll('.chip'), function (btn) {
      btn.addEventListener('click', function () {
        state.previewIdx = Number(btn.getAttribute('data-idx'));
        renderPreviewChips();
        renderPreviewArea();
      });
    });
  }

  function renderPreviewArea() {
    var clients = state.me.clients;
    var pIdx = Math.min(state.previewIdx, clients.length - 1);
    if (pIdx < 0) {
      el.previewArea.innerHTML = '<div class="empty-state">Add a company to see how a recruiter from it would view your profile. With an empty list, no recruiter can find you.</div>';
      return;
    }
    var preview = card(state.me, clients[pIdx].company);
    var otherCount = clients.length - 1;
    var note = 'A recruiter from ' + esc(clients[pIdx].company) + ' sees this card. ' +
      (otherCount > 0 ? ('Your ' + otherCount + ' other ' + (otherCount === 1 ? 'company stays' : 'companies stay') + ' hidden. ') : '') +
      'Recruiters from companies not on your list can’t find you.';
    el.previewArea.innerHTML =
      '<article class="preview-card">' +
        '<div class="preview-card-top">' +
          '<span class="avatar avatar-blue">' + esc(preview.initials) + '</span>' +
          '<div class="preview-card-name"><span class="name-serif">' + esc(preview.name) + '</span>' +
          '<span class="sub">' + esc(preview.title) + ' at <strong>' + esc(preview.employer) + '</strong></span></div>' +
        '</div>' +
        '<p class="preview-desc">' + esc(preview.desc) + '</p>' +
        '<div class="works-with-section">' +
          '<span class="label-caps">Works with</span>' +
          '<div class="works-with-box-lg"><span class="works-with-title">' + esc(preview.matchCompany) +
            ' <span class="works-with-you">· your company</span></span></div>' +
        '</div>' +
      '</article>' +
      '<p class="preview-note">' + note + '</p>';
  }

  function applyProfile(profile) {
    state.me = {
      name: profile.name, employer: profile.employer, title: profile.title, desc: profile.desc,
      clients: profile.clients, hasResume: !!profile.hasResume, resumeFilename: profile.resumeFilename || '',
      hasPassword: !!profile.hasPassword
    };
    state.candidateEmail = profile.email || state.candidateEmail;
    if (state.previewIdx >= state.me.clients.length) state.previewIdx = state.me.clients.length - 1;
    syncCandidateForm();
    renderClientRows();
    renderPreviewChips();
    renderPreviewArea();
    renderResumeStatus();
  }

  // ---- Candidate: resume upload/view ----
  function showResumeError(msg) { el.resumeError.textContent = msg; el.resumeError.hidden = false; }
  function hideResumeError() { el.resumeError.textContent = ''; el.resumeError.hidden = true; }

  function renderResumeStatus() {
    if (state.me.hasResume) {
      el.resumeStatus.textContent = state.me.resumeFilename || 'Resume uploaded.';
      el.resumeViewLink.hidden = false;
      el.resumeUploadBtn.textContent = 'Replace resume';
    } else {
      el.resumeStatus.textContent = 'No resume uploaded yet.';
      el.resumeViewLink.hidden = true;
      el.resumeUploadBtn.textContent = 'Upload resume';
    }
  }

  function uploadResume(file) {
    hideResumeError();
    var formData = new FormData();
    formData.append('resume', file);
    el.resumeUploadBtn.disabled = true;
    apiFetch('/api/professionals/me/resume', {
      method: 'POST',
      headers: authHeaders(),
      body: formData
    })
      .then(parseJson)
      .then(function (result) {
        el.resumeUploadBtn.disabled = false;
        if (!result.ok) { showResumeError(result.data.error || 'Could not upload resume.'); return; }
        applyProfile(result.data);
      })
      .catch(function (err) { el.resumeUploadBtn.disabled = false; showResumeError(err.message); });
  }

  function viewResume() {
    hideResumeError();
    apiFetch('/api/professionals/me/resume-url', { headers: authHeaders() })
      .then(parseJson)
      .then(function (result) {
        if (!result.ok) { showResumeError(result.data.error || 'Could not open resume.'); return; }
        openResume(result.data.url, result.data.contentType, state.me.resumeFilename || 'Your resume');
      })
      .catch(function (err) { showResumeError(err.message); });
  }

  // ---- Resume preview modal (PDFs render inline; other types open in a new tab) ----
  function openResume(url, contentType, title) {
    if (contentType === 'application/pdf') {
      el.resumeModalTitle.textContent = title || 'Resume';
      el.resumeModalFrame.src = url;
      el.resumeModal.hidden = false;
    } else {
      window.open(url, '_blank');
    }
  }

  function closeResumeModal() {
    el.resumeModal.hidden = true;
    el.resumeModalFrame.src = 'about:blank';
  }

  el.resumeModalClose.addEventListener('click', closeResumeModal);
  el.resumeModalBackdrop.addEventListener('click', closeResumeModal);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.resumeModal.hidden) closeResumeModal();
  });

  el.resumeUploadBtn.addEventListener('click', function () { el.resumeFileInput.click(); });
  el.resumeFileInput.addEventListener('change', function () {
    var file = el.resumeFileInput.files[0];
    el.resumeFileInput.value = '';
    if (file) uploadResume(file);
  });
  el.resumeViewLink.addEventListener('click', function (e) { e.preventDefault(); viewResume(); });

  // ---- Candidate: messages from recruiters ----
  function loadConversations() {
    apiFetch('/api/professionals/me/conversations', { headers: authHeaders() })
      .then(parseJson)
      .then(function (result) {
        state.conversations = result.ok ? result.data.conversations : [];
        renderConvList();
      })
      .catch(function () { state.conversations = []; renderConvList(); });
  }

  function renderConvList() {
    var convs = state.conversations;
    var selId = state.convSelectedId && convs.some(function (c) { return c.recruiterId === state.convSelectedId; })
      ? state.convSelectedId : (convs[0] ? convs[0].recruiterId : null);
    state.convSelectedId = selId;

    if (!convs.length) {
      el.convList.innerHTML = '<div class="empty-state" style="border:1px dashed var(--dashed-border);border-radius:14px;padding:28px;text-align:left">No messages yet. When a recruiter reaches out about a company you list, it’ll show up here.</div>';
      el.convDetailPanel.innerHTML = '';
      return;
    }

    el.convList.innerHTML = convs.map(function (c) {
      var active = c.recruiterId === selId;
      var prefix = c.lastSender === 'professional' ? 'You: ' : '';
      return '<button class="conv-row' + (active ? ' active' : '') + '" type="button" data-id="' + c.recruiterId + '">' +
        '<span class="avatar avatar-neutral">' + esc(initials(c.company)) + '</span>' +
        '<span class="conv-row-name"><span>' + esc(c.company) + '</span>' +
        '<span class="conv-row-preview">' + esc(prefix + c.lastMessage) + '</span></span>' +
        '</button>';
    }).join('');
    Array.prototype.forEach.call(el.convList.querySelectorAll('.conv-row'), function (btn) {
      btn.addEventListener('click', function () {
        state.convSelectedId = Number(btn.getAttribute('data-id'));
        renderConvList();
      });
    });

    renderConvDetail(selId);
  }

  function renderConvDetail(recruiterId) {
    if (!recruiterId) { el.convDetailPanel.innerHTML = ''; return; }
    var conv = state.conversations.find(function (c) { return c.recruiterId === recruiterId; });
    if (!conv) { el.convDetailPanel.innerHTML = ''; return; }

    var isNewSelection = state.convThreadForId !== recruiterId;
    if (isNewSelection) {
      state.convThreadForId = recruiterId;
      state.convThreadMessages = [];
    }

    el.convDetailPanel.innerHTML =
      '<div class="detail-top">' +
        '<span class="avatar avatar-blue detail-avatar">' + esc(initials(conv.company)) + '</span>' +
        '<div class="detail-name"><span class="name-serif">' + esc(conv.company) + '</span>' +
        '<span class="sub">A recruiter from this company</span></div>' +
      '</div>' +
      '<div id="conv-message-list" class="message-list"></div>' +
      '<div class="message-compose">' +
        '<textarea id="conv-message-input" rows="2" placeholder="Write a reply..."></textarea>' +
        '<button id="conv-message-send-btn" class="btn-dark-pill" type="button">Send</button>' +
      '</div>';

    renderConvMessageList();
    document.getElementById('conv-message-send-btn').addEventListener('click', function () { sendConvMessage(recruiterId); });
    document.getElementById('conv-message-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendConvMessage(recruiterId); }
    });

    if (isNewSelection) loadConvThread(recruiterId);
  }

  function renderConvMessageList() {
    var list = document.getElementById('conv-message-list');
    if (!list) return;
    if (!state.convThreadMessages.length) {
      list.innerHTML = '<div class="message-empty">No messages yet.</div>';
    } else {
      list.innerHTML = state.convThreadMessages.map(function (m) {
        return '<div class="message-bubble ' + (m.sender === 'professional' ? 'message-mine' : 'message-theirs') + '">' + esc(m.body) + '</div>';
      }).join('');
    }
    list.scrollTop = list.scrollHeight;
  }

  function loadConvThread(recruiterId) {
    apiFetch('/api/professionals/me/conversations/' + recruiterId + '/messages', { headers: authHeaders() })
      .then(parseJson)
      .then(function (result) {
        if (state.convThreadForId !== recruiterId) return;
        state.convThreadMessages = result.ok ? result.data.messages : [];
        renderConvMessageList();
      })
      .catch(function () {
        if (state.convThreadForId !== recruiterId) return;
        state.convThreadMessages = [];
        renderConvMessageList();
      });
  }

  function sendConvMessage(recruiterId) {
    var input = document.getElementById('conv-message-input');
    var text = input ? input.value.trim() : '';
    if (!text) return;
    var btn = document.getElementById('conv-message-send-btn');
    if (btn) btn.disabled = true;
    apiFetch('/api/professionals/me/conversations/' + recruiterId + '/messages', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body: text })
    })
      .then(parseJson)
      .then(function (result) {
        if (btn) btn.disabled = false;
        if (!result.ok) return;
        state.convThreadMessages = result.data.messages;
        if (input) input.value = '';
        renderConvMessageList();
        var conv = state.conversations.find(function (c) { return c.recruiterId === recruiterId; });
        if (conv) {
          conv.lastMessage = text;
          conv.lastSender = 'professional';
          renderConvList();
        }
      })
      .catch(function (err) { if (btn) btn.disabled = false; console.error(err); });
  }

  function loadProfessionalProfile() {
    var qs = state.justSetPasswordAtSignup ? '?justSetPassword=1' : '';
    apiFetch('/api/professionals/me' + qs, { headers: authHeaders() })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        state.professionalCheckDone = true;
        if (!data) { renderShell(); return; }
        state.justSetPasswordAtSignup = false;
        state.candidateLoggedIn = true;
        applyProfile(data);
        loadConversations();
        renderShell();
      })
      .catch(function (err) {
        console.error(err);
        state.professionalCheckDone = true;
        renderShell();
      });
  }

  function updateProfileField(field, value) {
    var body = {};
    body[field] = value;
    apiFetch('/api/professionals/me', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }).catch(function (err) { console.error(err); });
  }

  function addClient() {
    var company = state.newCo.trim();
    if (!company) return;
    el.addClientBtn.disabled = true;
    apiFetch('/api/professionals/me/clients', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ company: company })
    })
      .then(parseJson)
      .then(function (result) {
        el.addClientBtn.disabled = false;
        if (!result.ok) return;
        state.newCo = '';
        el.newCo.value = '';
        state.previewIdx = result.data.clients.length - 1;
        applyProfile(result.data);
      })
      .catch(function (err) { el.addClientBtn.disabled = false; console.error(err); });
  }

  function removeClient(clientId) {
    apiFetch('/api/professionals/me/clients/' + clientId, {
      method: 'DELETE',
      headers: authHeaders()
    })
      .then(parseJson)
      .then(function (result) {
        if (!result.ok) return;
        if (state.previewIdx >= result.data.clients.length) state.previewIdx = result.data.clients.length - 1;
        applyProfile(result.data);
      })
      .catch(function (err) { console.error(err); });
  }

  el.meName.addEventListener('input', function () { state.me.name = el.meName.value; renderPreviewArea(); });
  el.meName.addEventListener('change', function () { updateProfileField('name', state.me.name); });
  el.meEmployer.addEventListener('input', function () { state.me.employer = el.meEmployer.value; renderPreviewArea(); });
  el.meEmployer.addEventListener('change', function () { updateProfileField('employer', state.me.employer); });
  el.meTitle.addEventListener('input', function () { state.me.title = el.meTitle.value; renderPreviewArea(); });
  el.meTitle.addEventListener('change', function () { updateProfileField('title', state.me.title); });
  el.meDesc.addEventListener('input', function () { state.me.desc = el.meDesc.value; renderPreviewArea(); });
  el.meDesc.addEventListener('change', function () { updateProfileField('desc', state.me.desc); });
  el.newCo.addEventListener('input', function () { state.newCo = el.newCo.value; });
  el.newCo.addEventListener('keydown', function (e) { if (e.key === 'Enter') addClient(); });
  el.addClientBtn.addEventListener('click', addClient);

  // ---- Candidate: verify gate (Supabase email magic link, any email) ----
  function showCandEmailError(msg) { el.candEmailError.textContent = msg; el.candEmailError.hidden = false; }
  function hideCandEmailError() { el.candEmailError.textContent = ''; el.candEmailError.hidden = true; }

  function candidateRequestLink() {
    hideCandEmailError();
    var email = (state.candidateEmail || '').trim().toLowerCase();
    if (!email || email.indexOf('@') === -1 || !email.split('@')[1]) {
      showCandEmailError('Enter a valid email address.');
      return;
    }
    el.candVerifyBtn.disabled = true;
    localStorage.setItem(INTENDED_VIEW_KEY, 'candidate');
    sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: window.location.origin } }).then(function (result) {
      el.candVerifyBtn.disabled = false;
      if (result.error) { showCandEmailError(result.error.message); return; }
      state.candidateStage = 'sent';
      el.candSentEmail.textContent = email;
      renderShell();
    });
  }

  function candidateBackToEmail() {
    state.candidateStage = 'email';
    renderShell();
  }

  el.candEmail.addEventListener('input', function () { state.candidateEmail = el.candEmail.value; hideCandEmailError(); });
  el.candEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateRequestLink(); });
  el.candVerifyBtn.addEventListener('click', candidateRequestLink);
  el.candBackToEmailBtn.addEventListener('click', candidateBackToEmail);
  el.candidateSignOutBtn.addEventListener('click', signOutEverywhere);

  // ---- Candidate: password login (returning users who've already set one) ----
  function showCandLoginError(msg) { el.candLoginError.textContent = msg; el.candLoginError.hidden = false; }
  function hideCandLoginError() { el.candLoginError.textContent = ''; el.candLoginError.hidden = true; }

  function candidateLoginWithPassword() {
    hideCandLoginError();
    var email = (el.candLoginEmail.value || '').trim().toLowerCase();
    var password = el.candLoginPassword.value || '';
    if (!email || !password) { showCandLoginError('Enter your email and password.'); return; }
    el.candLoginBtn.disabled = true;
    sb.auth.signInWithPassword({ email: email, password: password }).then(function (result) {
      el.candLoginBtn.disabled = false;
      if (result.error) { showCandLoginError('Incorrect email or password.'); return; }
      // onAuthStateChange picks up the new session and signs the user in.
    });
  }

  function candidateShowLinkStage() {
    hideCandLoginError();
    state.candidateStage = 'email';
    renderShell();
  }

  function candidateShowPasswordStage() {
    hideCandEmailError();
    state.candidateStage = 'password';
    renderShell();
  }

  el.candLoginPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateLoginWithPassword(); });
  el.candLoginEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateLoginWithPassword(); });
  el.candLoginBtn.addEventListener('click', candidateLoginWithPassword);
  el.candUseLinkBtn.addEventListener('click', candidateShowLinkStage);
  el.candBackToPasswordBtn.addEventListener('click', candidateShowPasswordStage);

  // ---- Candidate: create account with email + password, verified via the same email link ----
  function showCandSignupError(msg) { el.candSignupError.textContent = msg; el.candSignupError.hidden = false; }
  function hideCandSignupError() { el.candSignupError.textContent = ''; el.candSignupError.hidden = true; }

  function candidateSignUp() {
    hideCandSignupError();
    var email = (el.candSignupEmail.value || '').trim().toLowerCase();
    var password = el.candSignupPassword.value || '';
    if (!email || email.indexOf('@') === -1 || !email.split('@')[1]) {
      showCandSignupError('Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      showCandSignupError('Use at least 8 characters.');
      return;
    }
    el.candSignupBtn.disabled = true;
    localStorage.setItem(INTENDED_VIEW_KEY, 'candidate');
    sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: window.location.origin } }).then(function (result) {
      el.candSignupBtn.disabled = false;
      if (result.error) { showCandSignupError(result.error.message); return; }
      if (result.data.user && result.data.user.identities && result.data.user.identities.length === 0) {
        showCandSignupError('This email already has an account. Try logging in, or use "Forgot your password" instead.');
        return;
      }
      localStorage.setItem(SIGNUP_PASSWORD_KEY, '1');
      if (result.data.session) return; // email confirmations off -- onAuthStateChange signs them in
      state.candidateStage = 'sent';
      el.candSentEmail.textContent = email;
      renderShell();
    });
  }

  function candidateGotoSignup() {
    hideCandLoginError();
    state.candidateStage = 'signup';
    renderShell();
  }

  function candidateSignupBackToPassword() {
    hideCandSignupError();
    state.candidateStage = 'password';
    renderShell();
  }

  el.candSignupPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateSignUp(); });
  el.candSignupEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateSignUp(); });
  el.candSignupBtn.addEventListener('click', candidateSignUp);
  el.candGotoSignupBtn.addEventListener('click', candidateGotoSignup);
  el.candSignupBackToPasswordBtn.addEventListener('click', candidateSignupBackToPassword);

  // ---- Candidate: set a password (so future sign-ins skip the email link) ----
  function showCandPasswordError(msg) { el.candPasswordError.textContent = msg; el.candPasswordError.hidden = false; }
  function hideCandPasswordError() { el.candPasswordError.textContent = ''; el.candPasswordError.hidden = true; }

  function saveCandPassword() {
    hideCandPasswordError();
    var pw = el.candNewPassword.value || '';
    if (pw.length < 8) { showCandPasswordError('Use at least 8 characters.'); return; }
    el.candSavePasswordBtn.disabled = true;
    sb.auth.updateUser({ password: pw }).then(function (result) {
      if (result.error) throw new Error(result.error.message);
      return apiFetch('/api/account/password-set', { method: 'POST', headers: authHeaders() });
    }).then(function () {
      el.candSavePasswordBtn.disabled = false;
      el.candNewPassword.value = '';
      state.me.hasPassword = true;
      renderShell();
    }).catch(function (err) {
      el.candSavePasswordBtn.disabled = false;
      showCandPasswordError(err.message);
    });
  }

  function skipCandPassword() {
    state.passwordSetupDismissedCand = true;
    renderShell();
  }

  el.candSavePasswordBtn.addEventListener('click', saveCandPassword);
  el.candNewPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveCandPassword(); });
  el.candSkipPasswordBtn.addEventListener('click', skipCandPassword);

  // ---- Recruiter: verify gate (Supabase email magic link, work email only) ----
  function showEmailError(msg) { el.emailError.textContent = msg; el.emailError.hidden = false; }
  function hideEmailError() { el.emailError.textContent = ''; el.emailError.hidden = true; }

  function isPersonalDomain(domain) { return /gmail|yahoo|outlook|hotmail|icloud/.test(domain); }

  function requestLink() {
    hideEmailError();
    var email = (state.email || '').trim().toLowerCase();
    var domain = email.split('@')[1];
    if (!domain || email.indexOf('@') === -1) { showEmailError('Enter a valid work email.'); return; }
    if (isPersonalDomain(domain)) { showEmailError('Personal email addresses can’t be verified. Use your company email.'); return; }
    el.verifyBtn.disabled = true;
    localStorage.setItem(INTENDED_VIEW_KEY, 'recruiter');
    sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: window.location.origin } }).then(function (result) {
      el.verifyBtn.disabled = false;
      if (result.error) { showEmailError(result.error.message); return; }
      state.recStage = 'sent';
      el.recSentEmail.textContent = email;
      renderShell();
    });
  }

  function backToEmail() {
    state.recStage = 'email';
    renderShell();
  }

  function loadOrFinalizeRecruiter() {
    apiFetch('/api/recruiters/me', { headers: authHeaders() })
      .then(function (res) { return res.ok ? res.json() : { __missing: true }; })
      .then(function (data) {
        if (data.__missing) return finalizeRecruiter();
        state.recruiterCheckDone = true;
        state.email = data.email;
        state.recCompany = data.company;
        state.recHasPassword = !!data.hasPassword;
        renderShell();
      })
      .catch(function (err) {
        console.error(err);
        state.recruiterCheckDone = true;
        renderShell();
      });
  }

  function finalizeRecruiter() {
    var justSetPassword = state.justSetPasswordAtSignup;
    var options = justSetPassword
      ? { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ justSetPassword: true }) }
      : { method: 'POST', headers: authHeaders() };
    apiFetch('/api/recruiters/finalize', options)
      .then(parseJson)
      .then(function (result) {
        if (justSetPassword) state.justSetPasswordAtSignup = false;
        state.recruiterCheckDone = true;
        if (!result.ok) {
          state.email = state.sbEmail || '';
          el.recEmail.value = state.email;
          showEmailError(result.data.error || 'Verify a work email to see recruiter results.');
          renderShell();
          return;
        }
        state.email = result.data.email;
        state.recCompany = result.data.company;
        state.recHasPassword = !!result.data.hasPassword;
        renderShell();
      })
      .catch(function (err) {
        console.error(err);
        state.recruiterCheckDone = true;
        renderShell();
      });
  }

  el.recEmail.addEventListener('input', function () { state.email = el.recEmail.value; hideEmailError(); });
  el.recEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') requestLink(); });
  el.verifyBtn.addEventListener('click', requestLink);
  el.backToEmailBtn.addEventListener('click', backToEmail);

  // ---- Recruiter: password login (returning users who've already set one) ----
  function showRecLoginError(msg) { el.recLoginError.textContent = msg; el.recLoginError.hidden = false; }
  function hideRecLoginError() { el.recLoginError.textContent = ''; el.recLoginError.hidden = true; }

  function recruiterLoginWithPassword() {
    hideRecLoginError();
    var email = (el.recLoginEmail.value || '').trim().toLowerCase();
    var password = el.recLoginPassword.value || '';
    if (!email || !password) { showRecLoginError('Enter your email and password.'); return; }
    el.recLoginBtn.disabled = true;
    sb.auth.signInWithPassword({ email: email, password: password }).then(function (result) {
      el.recLoginBtn.disabled = false;
      if (result.error) { showRecLoginError('Incorrect email or password.'); return; }
      // onAuthStateChange picks up the new session and signs the user in.
    });
  }

  function recruiterShowLinkStage() {
    hideRecLoginError();
    state.recStage = 'email';
    renderShell();
  }

  function recruiterShowPasswordStage() {
    hideEmailError();
    state.recStage = 'password';
    renderShell();
  }

  el.recLoginPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') recruiterLoginWithPassword(); });
  el.recLoginEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') recruiterLoginWithPassword(); });
  el.recLoginBtn.addEventListener('click', recruiterLoginWithPassword);
  el.recUseLinkBtn.addEventListener('click', recruiterShowLinkStage);
  el.recBackToPasswordBtn.addEventListener('click', recruiterShowPasswordStage);

  // ---- Recruiter: create account with work email + password, verified via the same email link ----
  function showRecSignupError(msg) { el.recSignupError.textContent = msg; el.recSignupError.hidden = false; }
  function hideRecSignupError() { el.recSignupError.textContent = ''; el.recSignupError.hidden = true; }

  function recruiterSignUp() {
    hideRecSignupError();
    var email = (el.recSignupEmail.value || '').trim().toLowerCase();
    var domain = email.split('@')[1];
    var password = el.recSignupPassword.value || '';
    if (!domain || email.indexOf('@') === -1) { showRecSignupError('Enter a valid work email.'); return; }
    if (isPersonalDomain(domain)) { showRecSignupError('Personal email addresses can’t be verified. Use your company email.'); return; }
    if (password.length < 8) { showRecSignupError('Use at least 8 characters.'); return; }
    el.recSignupBtn.disabled = true;
    localStorage.setItem(INTENDED_VIEW_KEY, 'recruiter');
    sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: window.location.origin } }).then(function (result) {
      el.recSignupBtn.disabled = false;
      if (result.error) { showRecSignupError(result.error.message); return; }
      if (result.data.user && result.data.user.identities && result.data.user.identities.length === 0) {
        showRecSignupError('This email already has an account. Try logging in, or use "Forgot your password" instead.');
        return;
      }
      localStorage.setItem(SIGNUP_PASSWORD_KEY, '1');
      if (result.data.session) return; // email confirmations off -- onAuthStateChange signs them in
      state.recStage = 'sent';
      el.recSentEmail.textContent = email;
      renderShell();
    });
  }

  function recruiterGotoSignup() {
    hideRecLoginError();
    state.recStage = 'signup';
    renderShell();
  }

  function recruiterSignupBackToPassword() {
    hideRecSignupError();
    state.recStage = 'password';
    renderShell();
  }

  el.recSignupPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') recruiterSignUp(); });
  el.recSignupEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') recruiterSignUp(); });
  el.recSignupBtn.addEventListener('click', recruiterSignUp);
  el.recGotoSignupBtn.addEventListener('click', recruiterGotoSignup);
  el.recSignupBackToPasswordBtn.addEventListener('click', recruiterSignupBackToPassword);

  // ---- Recruiter: set a password (so future sign-ins skip the email link) ----
  function showRecPasswordError(msg) { el.recPasswordError.textContent = msg; el.recPasswordError.hidden = false; }
  function hideRecPasswordError() { el.recPasswordError.textContent = ''; el.recPasswordError.hidden = true; }

  function saveRecPassword() {
    hideRecPasswordError();
    var pw = el.recNewPassword.value || '';
    if (pw.length < 8) { showRecPasswordError('Use at least 8 characters.'); return; }
    el.recSavePasswordBtn.disabled = true;
    sb.auth.updateUser({ password: pw }).then(function (result) {
      if (result.error) throw new Error(result.error.message);
      return apiFetch('/api/account/password-set', { method: 'POST', headers: authHeaders() });
    }).then(function () {
      el.recSavePasswordBtn.disabled = false;
      el.recNewPassword.value = '';
      state.recHasPassword = true;
      renderShell();
    }).catch(function (err) {
      el.recSavePasswordBtn.disabled = false;
      showRecPasswordError(err.message);
    });
  }

  function skipRecPassword() {
    state.passwordSetupDismissedRec = true;
    renderShell();
  }

  el.recSavePasswordBtn.addEventListener('click', saveRecPassword);
  el.recNewPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveRecPassword(); });
  el.recSkipPasswordBtn.addEventListener('click', skipRecPassword);

  // ---- Recruiter: results ----
  function loadAndRenderResults() {
    el.resultsHeading.textContent = 'People who work with ' + state.recCompany;
    el.resultsEmail.textContent = state.email;
    apiFetch('/api/recruiters/matches', { headers: authHeaders() })
      .then(parseJson)
      .then(function (result) {
        state.matches = result.ok ? result.data.matches : [];
        renderResultsBody();
      })
      .catch(function (err) {
        console.error(err);
        state.matches = [];
        renderResultsBody();
      });
  }

  function renderResultsBody() {
    var matches = state.matches;
    var recCompany = state.recCompany;
    var selId = state.selectedId && matches.some(function (m) { return m.id === state.selectedId; }) ? state.selectedId : (matches[0] ? matches[0].id : null);

    el.resultsCount.textContent = matches.length + ' ' + (matches.length === 1 ? 'person lists' : 'people list') + ' ' + recCompany + ' as a company they work with.';

    if (matches.length === 0) {
      el.matchesList.innerHTML = '<div class="empty-state" style="border:1px dashed var(--dashed-border);border-radius:14px;padding:28px;text-align:left">No one has listed ' + esc(recCompany) + ' yet.</div>';
    } else {
      el.matchesList.innerHTML = matches.map(function (p) {
        var active = p.id === selId;
        return '<button class="match-row' + (active ? ' active' : '') + '" type="button" data-id="' + p.id + '">' +
          '<span class="avatar avatar-neutral">' + esc(initials(p.name)) + '</span>' +
          '<span class="match-row-name"><span>' + esc(p.name) + '</span>' +
          '<span class="match-row-sub">' + esc(p.title) + ' · ' + esc(p.employer) + '</span></span>' +
          (p.contacted ? '<span class="match-contacted">Contacted</span>' : '') +
          '</button>';
      }).join('');
      Array.prototype.forEach.call(el.matchesList.querySelectorAll('.match-row'), function (btn) {
        btn.addEventListener('click', function () {
          state.selectedId = Number(btn.getAttribute('data-id'));
          renderResultsBody();
        });
      });
    }

    var selP = matches.find(function (m) { return m.id === selId; });
    if (!selP) {
      el.detailPanel.innerHTML = '';
      state.threadForId = null;
      return;
    }

    var isNewSelection = state.threadForId !== selP.id;
    if (isNewSelection) {
      state.threadForId = selP.id;
      state.threadMessages = [];
    }

    el.detailPanel.innerHTML =
      '<div class="detail-top">' +
        '<span class="avatar avatar-blue detail-avatar">' + esc(initials(selP.name)) + '</span>' +
        '<div class="detail-name"><span class="name-serif">' + esc(selP.name) + '</span>' +
        '<span class="sub">' + esc(selP.title) + ' at <strong>' + esc(selP.employer) + '</strong></span></div>' +
        (selP.hasResume ? '<button class="link-btn" type="button" id="resume-link-btn">View resume</button>' : '') +
      '</div>' +
      '<p class="detail-desc">' + esc(selP.desc) + '</p>' +
      '<div class="works-with-section">' +
        '<span class="label-caps">Works with</span>' +
        '<div class="works-with-box-lg detail-works-box"><span class="works-with-title">' + esc(selP.matchCompany) +
          ' <span class="works-with-you">· your company</span></span></div>' +
      '</div>' +
      '<div class="works-with-section">' +
        '<span class="label-caps">Message ' + esc((selP.name || '').split(/\s+/)[0] || selP.name) + '</span>' +
        '<div id="message-list" class="message-list"></div>' +
        '<div class="message-compose">' +
          '<textarea id="message-input" rows="2" placeholder="Write a message..."></textarea>' +
          '<button id="message-send-btn" class="btn-dark-pill" type="button">Send</button>' +
        '</div>' +
      '</div>';

    var resumeLinkBtn = document.getElementById('resume-link-btn');
    if (resumeLinkBtn) {
      resumeLinkBtn.addEventListener('click', function () { viewMatchResume(selP.id, selP.name); });
    }
    renderMessageList();
    document.getElementById('message-send-btn').addEventListener('click', function () { sendMessage(selP.id); });
    document.getElementById('message-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(selP.id); }
    });

    if (isNewSelection) loadThread(selP.id);
  }

  function viewMatchResume(professionalId, name) {
    apiFetch('/api/recruiters/matches/' + professionalId + '/resume-url', { headers: authHeaders() })
      .then(parseJson)
      .then(function (result) {
        if (!result.ok) { console.error(result.data.error); return; }
        openResume(result.data.url, result.data.contentType, name ? name + '’s resume' : 'Resume');
      })
      .catch(function (err) { console.error(err); });
  }

  function renderMessageList() {
    var list = document.getElementById('message-list');
    if (!list) return;
    if (!state.threadMessages.length) {
      list.innerHTML = '<div class="message-empty">No messages yet. Say hello.</div>';
    } else {
      list.innerHTML = state.threadMessages.map(function (m) {
        return '<div class="message-bubble ' + (m.sender === 'recruiter' ? 'message-mine' : 'message-theirs') + '">' + esc(m.body) + '</div>';
      }).join('');
    }
    list.scrollTop = list.scrollHeight;
  }

  function loadThread(professionalId) {
    apiFetch('/api/recruiters/matches/' + professionalId + '/messages', { headers: authHeaders() })
      .then(parseJson)
      .then(function (result) {
        if (state.threadForId !== professionalId) return;
        state.threadMessages = result.ok ? result.data.messages : [];
        renderMessageList();
      })
      .catch(function () {
        if (state.threadForId !== professionalId) return;
        state.threadMessages = [];
        renderMessageList();
      });
  }

  function sendMessage(professionalId) {
    var input = document.getElementById('message-input');
    var text = input ? input.value.trim() : '';
    if (!text) return;
    var btn = document.getElementById('message-send-btn');
    if (btn) btn.disabled = true;
    apiFetch('/api/recruiters/matches/' + professionalId + '/messages', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body: text })
    })
      .then(parseJson)
      .then(function (result) {
        if (btn) btn.disabled = false;
        if (!result.ok) return;
        state.threadMessages = result.data.messages;
        if (input) input.value = '';
        renderMessageList();
        var match = state.matches.find(function (m) { return m.id === professionalId; });
        if (match && !match.contacted) {
          match.contacted = true;
          var row = el.matchesList.querySelector('.match-row[data-id="' + professionalId + '"]');
          if (row && !row.querySelector('.match-contacted')) {
            row.insertAdjacentHTML('beforeend', '<span class="match-contacted">Contacted</span>');
          }
        }
      })
      .catch(function (err) { if (btn) btn.disabled = false; console.error(err); });
  }

  el.signOutBtn.addEventListener('click', signOutEverywhere);

  // ---- Shared Supabase session handling ----
  function resetSignedOutState() {
    state.sbToken = null;
    state.sbEmail = null;
    state.recruiterChecked = false;
    state.professionalLoaded = false;
    state.professionalCheckDone = false;
    state.recruiterCheckDone = false;
    state.candidateLoggedIn = false;
    state.candidateStage = 'password';
    state.candidateEmail = '';
    state.previewIdx = 0;
    state.recCompany = null;
    state.email = '';
    state.recStage = 'password';
    state.recHasPassword = false;
    state.selectedId = null;
    state.matches = [];
    state.threadForId = null;
    state.threadMessages = [];
    state.conversations = [];
    state.convSelectedId = null;
    state.convThreadForId = null;
    state.convThreadMessages = [];
    state.passwordSetupDismissedCand = false;
    state.passwordSetupDismissedRec = false;
    state.justSetPasswordAtSignup = false;
    el.candEmail.value = '';
    el.recEmail.value = '';
    el.candLoginEmail.value = '';
    el.candLoginPassword.value = '';
    el.recLoginEmail.value = '';
    el.recLoginPassword.value = '';
    el.candSignupEmail.value = '';
    el.candSignupPassword.value = '';
    el.recSignupEmail.value = '';
    el.recSignupPassword.value = '';
    el.candNewPassword.value = '';
    el.recNewPassword.value = '';
    el.detailPanel.innerHTML = '';
    el.convList.innerHTML = '';
    el.convDetailPanel.innerHTML = '';
    closeResumeModal();
    hideCandEmailError();
    hideEmailError();
    hideCandLoginError();
    hideRecLoginError();
    hideCandSignupError();
    hideRecSignupError();
    hideCandPasswordError();
    hideRecPasswordError();
    applyProfile({ name: '', employer: '', title: '', desc: '', clients: [], email: '' });
  }

  function onSignedIn(session) {
    var isNewIdentity = state.sbEmail && state.sbEmail !== session.user.email;
    state.sbToken = session.access_token;
    state.sbEmail = session.user.email;

    var intendedView = localStorage.getItem(INTENDED_VIEW_KEY);
    if (intendedView === 'candidate' || intendedView === 'recruiter') {
      localStorage.removeItem(INTENDED_VIEW_KEY);
      state.view = intendedView;
    }

    if (isNewIdentity) {
      // Signed in as someone else without an explicit sign-out first (e.g. verified a
      // different email on the other tab's gate) -- clear stale per-identity state.
      state.recruiterChecked = false;
      state.professionalLoaded = false;
      state.professionalCheckDone = false;
      state.recruiterCheckDone = false;
      state.candidateLoggedIn = false;
      state.recCompany = null;
      state.email = '';
      state.recHasPassword = false;
      state.selectedId = null;
      state.matches = [];
      state.threadForId = null;
      state.threadMessages = [];
      state.conversations = [];
      state.convSelectedId = null;
      state.convThreadForId = null;
      state.convThreadMessages = [];
      state.passwordSetupDismissedCand = false;
      state.passwordSetupDismissedRec = false;
      state.justSetPasswordAtSignup = false;
      el.detailPanel.innerHTML = '';
      el.convList.innerHTML = '';
      el.convDetailPanel.innerHTML = '';
      closeResumeModal();
      applyProfile({ name: '', employer: '', title: '', desc: '', clients: [], email: '' });
    }

    if (localStorage.getItem(SIGNUP_PASSWORD_KEY)) {
      // They just created their password at signup -- the professional/recruiter row
      // doesn't exist yet at this point, so this can't be a separate flag-it-afterward
      // call (it would silently no-op against a row that isn't there yet). Instead the
      // very call that creates the row, just below, is told to mark it has_password
      // from the start. Consumed once so a later visit to the *other* role isn't affected.
      localStorage.removeItem(SIGNUP_PASSWORD_KEY);
      state.justSetPasswordAtSignup = true;
    }
    renderShell();
  }

  function signOutEverywhere() {
    sb.auth.signOut().then(function () {
      resetSignedOutState();
      renderShell();
    });
  }

  sb.auth.onAuthStateChange(function (event, session) {
    var firstCheck = !state.authChecked;
    state.authChecked = true;
    if (session && session.access_token !== state.sbToken) {
      onSignedIn(session);
    } else if (!session && state.sbToken) {
      resetSignedOutState();
      renderShell();
    } else if (firstCheck) {
      renderShell(); // nothing changed, but the loading state needs to clear now
    }
  });

  // Safety net: if the session check never fires for some reason (e.g. a
  // blocked request), don't leave the user stuck on "Loading..." forever.
  setTimeout(function () {
    if (!state.authChecked) { state.authChecked = true; renderShell(); }
  }, 5000);

  // ---- Account dropdown menus ----
  function setupAccountMenu(trigger, dropdown) {
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = dropdown.hidden;
      document.querySelectorAll('.account-dropdown').forEach(function (d) { d.hidden = true; });
      dropdown.hidden = !willOpen;
    });
    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
  }
  setupAccountMenu(el.candidateAccountTrigger, el.candidateAccountDropdown);
  setupAccountMenu(el.recruiterAccountTrigger, el.recruiterAccountDropdown);
  document.addEventListener('click', function () {
    document.querySelectorAll('.account-dropdown').forEach(function (d) { d.hidden = true; });
  });

  // ---- Navigation wiring ----
  el.logoBtn.addEventListener('click', function () { goTo('landing'); });
  el.tabCandidate.addEventListener('click', function () { goTo('candidate'); });
  el.tabRecruiter.addEventListener('click', function () { goTo('recruiter'); });
  el.cardCandidate.addEventListener('click', function () { goTo('candidate'); });
  el.cardRecruiter.addEventListener('click', function () { goTo('recruiter'); });

  // ---- Init ----
  syncCandidateForm();
  renderClientRows();
  renderPreviewChips();
  renderPreviewArea();
  renderShell();
})();

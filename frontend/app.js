(function () {
  'use strict';

  var API_BASE = '';
  var RECRUITER_TOKEN_KEY = 'workedwith_recruiter_token';
  var PROFESSIONAL_TOKEN_KEY = 'workedwith_professional_token';
  var DOMAINS = { 'stripe.com': 'Stripe', 'shopify.com': 'Shopify', 'delta.com': 'Delta', 'nike.com': 'Nike' };

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

  function profAuthHeaders(extra) {
    var token = localStorage.getItem(PROFESSIONAL_TOKEN_KEY);
    var headers = Object.assign({}, extra || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  var state = {
    view: 'landing',
    me: { name: '', employer: '', title: '', desc: '', clients: [] },
    candidateLoggedIn: false, candidateStage: 'email', candidateEmail: '', candidatePendingEmail: '',
    newCo: '', previewIdx: 0,
    email: '', recStage: 'email', pendingEmail: '',
    recCompany: null, selectedId: null, contacted: {}, matches: []
  };

  var el = {};
  ['logo-btn', 'tab-candidate', 'tab-recruiter', 'card-candidate', 'card-recruiter',
    'view-landing', 'view-candidate', 'view-recruiter-unverified', 'view-recruiter-verified',
    'candidate-gate', 'candidate-content', 'candidate-stage-email', 'candidate-stage-code',
    'cand-email', 'cand-email-error', 'cand-verify-btn',
    'cand-code-stage-email', 'cand-dev-code-banner', 'cand-code', 'cand-code-error',
    'cand-verify-code-btn', 'cand-back-to-email-btn',
    'candidate-signed-in-as', 'candidate-sign-out-btn',
    'me-name', 'me-employer', 'me-title', 'me-desc',
    'client-rows', 'new-co', 'add-client-btn',
    'preview-chips', 'preview-area',
    'verify-stage-email', 'verify-stage-code',
    'rec-email', 'email-error', 'verify-btn', 'demo-emails',
    'code-stage-email', 'dev-code-banner', 'rec-code', 'code-error', 'verify-code-btn', 'back-to-email-btn',
    'results-heading', 'results-count', 'results-email', 'sign-out-btn',
    'matches-list', 'detail-panel'
  ].forEach(function (id) { el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id); });

  function goTo(view) {
    state.view = view;
    renderShell();
  }

  function renderShell() {
    document.getElementById('view-landing').classList.toggle('active', state.view === 'landing');
    document.getElementById('view-candidate').classList.toggle('active', state.view === 'candidate');
    var recruiterUnverified = state.view === 'recruiter' && !state.recCompany;
    var recruiterVerified = state.view === 'recruiter' && !!state.recCompany;
    document.getElementById('view-recruiter-unverified').classList.toggle('active', recruiterUnverified);
    document.getElementById('view-recruiter-verified').classList.toggle('active', recruiterVerified);
    el.tabCandidate.classList.toggle('active', state.view === 'candidate');
    el.tabRecruiter.classList.toggle('active', state.view === 'recruiter');

    el.candidateGate.hidden = state.candidateLoggedIn;
    el.candidateContent.hidden = !state.candidateLoggedIn;
    el.candidateStageEmail.hidden = state.candidateStage !== 'email';
    el.candidateStageCode.hidden = state.candidateStage !== 'code';
    if (state.candidateLoggedIn) el.candidateSignedInAs.textContent = 'Signed in as ' + state.candidateEmail;

    el.verifyStageEmail.hidden = state.recStage !== 'email';
    el.verifyStageCode.hidden = state.recStage !== 'code';

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
    state.me = { name: profile.name, employer: profile.employer, title: profile.title, desc: profile.desc, clients: profile.clients };
    state.candidateEmail = profile.email || state.candidateEmail;
    if (state.previewIdx >= state.me.clients.length) state.previewIdx = state.me.clients.length - 1;
    syncCandidateForm();
    renderClientRows();
    renderPreviewChips();
    renderPreviewArea();
  }

  function updateProfileField(field, value) {
    var body = {};
    body[field] = value;
    apiFetch('/api/professionals/me', {
      method: 'PUT',
      headers: profAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }).catch(function (err) { console.error(err); });
  }

  function addClient() {
    var company = state.newCo.trim();
    if (!company) return;
    el.addClientBtn.disabled = true;
    apiFetch('/api/professionals/me/clients', {
      method: 'POST',
      headers: profAuthHeaders({ 'Content-Type': 'application/json' }),
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
      headers: profAuthHeaders()
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

  // ---- Candidate: verify gate ----
  function showCandEmailError(msg) { el.candEmailError.textContent = msg; el.candEmailError.hidden = false; }
  function hideCandEmailError() { el.candEmailError.textContent = ''; el.candEmailError.hidden = true; }
  function showCandCodeError(msg) { el.candCodeError.textContent = msg; el.candCodeError.hidden = false; }
  function hideCandCodeError() { el.candCodeError.textContent = ''; el.candCodeError.hidden = true; }

  function candidateRequestCode() {
    hideCandEmailError();
    var email = (state.candidateEmail || '').trim();
    el.candVerifyBtn.disabled = true;
    apiFetch('/api/professionals/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
      .then(parseJson)
      .then(function (result) {
        el.candVerifyBtn.disabled = false;
        if (!result.ok) { showCandEmailError(result.data.error || 'Something went wrong.'); return; }
        state.candidatePendingEmail = result.data.email;
        state.candidateStage = 'code';
        el.candCodeStageEmail.textContent = result.data.email;
        el.candCode.value = '';
        hideCandCodeError();
        if (result.data.devCode) {
          el.candDevCodeBanner.hidden = false;
          el.candDevCodeBanner.innerHTML = 'Dev mode (no email sent): your code is <strong>' + esc(result.data.devCode) + '</strong>';
        } else {
          el.candDevCodeBanner.hidden = true;
        }
        renderShell();
        el.candCode.focus();
      })
      .catch(function (err) {
        el.candVerifyBtn.disabled = false;
        showCandEmailError(err.message);
      });
  }

  function candidateVerifyCode() {
    hideCandCodeError();
    var code = el.candCode.value.trim();
    el.candVerifyCodeBtn.disabled = true;
    apiFetch('/api/professionals/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.candidatePendingEmail, code: code })
    })
      .then(parseJson)
      .then(function (result) {
        el.candVerifyCodeBtn.disabled = false;
        if (!result.ok) { showCandCodeError(result.data.error || 'Something went wrong.'); return; }
        localStorage.setItem(PROFESSIONAL_TOKEN_KEY, result.data.token);
        state.candidateLoggedIn = true;
        state.candidateStage = 'email';
        applyProfile(result.data.profile);
        renderShell();
      })
      .catch(function (err) {
        el.candVerifyCodeBtn.disabled = false;
        showCandCodeError(err.message);
      });
  }

  function candidateBackToEmail() {
    state.candidateStage = 'email';
    hideCandCodeError();
    renderShell();
  }

  function candidateSignOut() {
    localStorage.removeItem(PROFESSIONAL_TOKEN_KEY);
    state.candidateLoggedIn = false;
    state.candidateStage = 'email';
    state.candidateEmail = '';
    state.candidatePendingEmail = '';
    state.previewIdx = 0;
    el.candEmail.value = '';
    hideCandEmailError();
    applyProfile({ name: '', employer: '', title: '', desc: '', clients: [], email: '' });
    renderShell();
  }

  function restoreCandidateSession() {
    var token = localStorage.getItem(PROFESSIONAL_TOKEN_KEY);
    if (!token) return;
    apiFetch('/api/professionals/me', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) { localStorage.removeItem(PROFESSIONAL_TOKEN_KEY); return; }
        state.candidateLoggedIn = true;
        applyProfile(data);
        renderShell();
      })
      .catch(function () {});
  }

  el.candEmail.addEventListener('input', function () { state.candidateEmail = el.candEmail.value; hideCandEmailError(); });
  el.candEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateRequestCode(); });
  el.candVerifyBtn.addEventListener('click', candidateRequestCode);
  el.candCode.addEventListener('input', hideCandCodeError);
  el.candCode.addEventListener('keydown', function (e) { if (e.key === 'Enter') candidateVerifyCode(); });
  el.candVerifyCodeBtn.addEventListener('click', candidateVerifyCode);
  el.candBackToEmailBtn.addEventListener('click', candidateBackToEmail);
  el.candidateSignOutBtn.addEventListener('click', candidateSignOut);

  // ---- Recruiter: verify ----
  function renderDemoEmails() {
    el.demoEmails.innerHTML = Object.keys(DOMAINS).map(function (d) {
      return '<button class="demo-chip" type="button" data-email="jordan@' + esc(d) + '">jordan@' + esc(d) + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.demoEmails.querySelectorAll('.demo-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-email');
        state.email = email;
        el.recEmail.value = email;
        hideEmailError();
      });
    });
  }

  function showEmailError(msg) {
    el.emailError.textContent = msg;
    el.emailError.hidden = false;
  }
  function hideEmailError() {
    el.emailError.textContent = '';
    el.emailError.hidden = true;
  }
  function showCodeError(msg) {
    el.codeError.textContent = msg;
    el.codeError.hidden = false;
  }
  function hideCodeError() {
    el.codeError.textContent = '';
    el.codeError.hidden = true;
  }

  function requestCode() {
    hideEmailError();
    var email = (state.email || '').trim();
    el.verifyBtn.disabled = true;
    apiFetch('/api/recruiters/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
      .then(parseJson)
      .then(function (result) {
        el.verifyBtn.disabled = false;
        if (!result.ok) { showEmailError(result.data.error || 'Something went wrong.'); return; }
        state.pendingEmail = result.data.email;
        state.recStage = 'code';
        el.codeStageEmail.textContent = result.data.email;
        el.recCode.value = '';
        hideCodeError();
        if (result.data.devCode) {
          el.devCodeBanner.hidden = false;
          el.devCodeBanner.innerHTML = 'Dev mode (no email sent): your code is <strong>' + esc(result.data.devCode) + '</strong>';
        } else {
          el.devCodeBanner.hidden = true;
        }
        renderShell();
        el.recCode.focus();
      })
      .catch(function (err) {
        el.verifyBtn.disabled = false;
        showEmailError(err.message);
      });
  }

  function verifyCode() {
    hideCodeError();
    var code = el.recCode.value.trim();
    el.verifyCodeBtn.disabled = true;
    apiFetch('/api/recruiters/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.pendingEmail, code: code })
    })
      .then(parseJson)
      .then(function (result) {
        el.verifyCodeBtn.disabled = false;
        if (!result.ok) { showCodeError(result.data.error || 'Something went wrong.'); return; }
        localStorage.setItem(RECRUITER_TOKEN_KEY, result.data.token);
        state.email = result.data.email;
        state.recCompany = result.data.company;
        state.selectedId = null;
        state.contacted = {};
        state.recStage = 'email';
        renderShell();
      })
      .catch(function (err) {
        el.verifyCodeBtn.disabled = false;
        showCodeError(err.message);
      });
  }

  function backToEmail() {
    state.recStage = 'email';
    hideCodeError();
    renderShell();
  }

  function restoreSession() {
    var token = localStorage.getItem(RECRUITER_TOKEN_KEY);
    if (!token) return;
    apiFetch('/api/recruiters/me', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) { localStorage.removeItem(RECRUITER_TOKEN_KEY); return; }
        state.email = data.email;
        state.recCompany = data.company;
        renderShell();
      })
      .catch(function () {});
  }

  el.recEmail.addEventListener('input', function () { state.email = el.recEmail.value; hideEmailError(); });
  el.recEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') requestCode(); });
  el.verifyBtn.addEventListener('click', requestCode);
  el.recCode.addEventListener('input', hideCodeError);
  el.recCode.addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyCode(); });
  el.verifyCodeBtn.addEventListener('click', verifyCode);
  el.backToEmailBtn.addEventListener('click', backToEmail);

  // ---- Recruiter: results ----
  function loadAndRenderResults() {
    var token = localStorage.getItem(RECRUITER_TOKEN_KEY);
    el.resultsHeading.textContent = 'People who work with ' + state.recCompany;
    el.resultsEmail.textContent = state.email;
    apiFetch('/api/recruiters/matches', { headers: { Authorization: 'Bearer ' + token } })
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
          (state.contacted[p.id] ? '<span class="match-contacted">Contacted</span>' : '') +
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
      return;
    }
    var contacted = !!state.contacted[selP.id];
    el.detailPanel.innerHTML =
      '<div class="detail-top">' +
        '<span class="avatar avatar-blue detail-avatar">' + esc(initials(selP.name)) + '</span>' +
        '<div class="detail-name"><span class="name-serif">' + esc(selP.name) + '</span>' +
        '<span class="sub">' + esc(selP.title) + ' at <strong>' + esc(selP.employer) + '</strong></span></div>' +
        (contacted
          ? '<span class="request-sent">Request sent</span>'
          : '<button class="reach-out-btn" type="button" id="contact-btn">Reach out</button>') +
      '</div>' +
      '<p class="detail-desc">' + esc(selP.desc) + '</p>' +
      '<div class="works-with-section">' +
        '<span class="label-caps">Works with</span>' +
        '<div class="works-with-box-lg detail-works-box"><span class="works-with-title">' + esc(selP.matchCompany) +
          ' <span class="works-with-you">· your company</span></span></div>' +
      '</div>';
    var contactBtn = document.getElementById('contact-btn');
    if (contactBtn) {
      contactBtn.addEventListener('click', function () {
        state.contacted[selP.id] = true;
        renderResultsBody();
      });
    }
  }

  function signOut() {
    localStorage.removeItem(RECRUITER_TOKEN_KEY);
    state.recCompany = null;
    state.email = '';
    state.pendingEmail = '';
    state.recStage = 'email';
    state.selectedId = null;
    state.contacted = {};
    state.matches = [];
    el.recEmail.value = '';
    hideEmailError();
    renderShell();
  }
  el.signOutBtn.addEventListener('click', signOut);

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
  renderDemoEmails();
  renderShell();
  restoreSession();
  restoreCandidateSession();
})();

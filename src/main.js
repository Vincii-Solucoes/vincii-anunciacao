import '@fontsource-variable/inter';
import './style.css';
import { store, uid, DEMO, NATIVE, ACCOUNT_DEFAULTS } from './store.js';
import { Phone } from './sip/phone.js';
import { I } from './icons.js';
import { unlockAudio, setRinger, dtmfTone } from './audio.js';
import { seedDemo, randomCaller } from './demo.js';
import { CODECS, normalizeCodecs, enabledCodecs, opusSupported, loadG729 } from './media/codecs.js';

const COLORS = ['#00C9B1', '#4DA3FF', '#F5B83D', '#E86A92', '#9B7BFF', '#6BD16B'];
const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];
const STATUS = { registered: 'Registrada', connecting: 'Conectando…', failed: 'Erro', offline: 'Desconectada', disabled: 'Desativada' };
const CALL_STATE = { dialing: 'Chamando…', ringback: 'Tocando…', connecting: 'Conectando…', active: 'Em chamada', held: 'Em espera' };
const RESULT = {
  answered: 'Atendida',
  missed: 'Perdida',
  rejected: 'Recusada',
  cancelled: 'Cancelada',
  failed: 'Falhou',
  forwarded: 'Desviada',
  transferred: 'Transferida',
  dnd: 'Não perturbe',
};
const FWD = { off: 'Desativado', always: 'Sempre', busy: 'Se ocupado', noanswer: 'Se não atender' };

const ui = { tab: 'dialer', selectedLine: null, panel: {}, transfer: {}, themePreview: null };
let phone;

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lineOf = (id) => phone.lines.get(id);
const colorOf = (id) => lineOf(id)?.account.color || '#666';
const lineName = (id) => {
  const a = lineOf(id)?.account;
  return a ? a.name || a.user : 'Linha';
};
const fmtDur = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
};
const since = (t) => fmtDur(Math.max(0, Math.floor((Date.now() - t) / 1000)));
const fmtNumber = (n) => {
  const d = String(n || '');
  if (/^\d{11}$/.test(d)) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (/^\d{10}$/.test(d)) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
};
const who = (c) => c.name || fmtNumber(c.number) || 'Desconhecido';
const initials = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  return w.length ? esc((w[0][0] + (w[1]?.[0] || '')).toUpperCase()) : I.phone;
};
const liveCalls = () => [...phone.calls.values()].filter((c) => c.state === 'active' || c.state === 'held');

/* ================= Estrutura ================= */

function shell() {
  $('#app').innerHTML = `
  <header class="topbar">
    <div class="brand">
      <img class="brand-icon" src="./brand.png" alt="Vincii Anunciação" draggable="false" />
      <div class="brand-text">
        <h1>Vincii Anunciação</h1>
        <p>Cliente VoIP da Vincii</p>
      </div>
    </div>
    <div class="summary" id="summary"></div>
    <div class="top-actions">
      <button class="icon-btn" id="btn-theme" aria-label="Tema"></button>
      <button class="icon-btn" id="btn-dnd" title="Não perturbe" aria-label="Não perturbe"></button>
      <button class="icon-btn" id="btn-settings" title="Configurações" aria-label="Configurações">${I.settings}</button>
    </div>
  </header>
  <main class="layout">
    <section class="panel lines-panel">
      <div class="panel-head"><h2>Linhas</h2><span class="muted" id="lines-count"></span></div>
      <div id="lines" class="lines"></div>
      <button class="btn btn-outline block" id="btn-add-line">${I.plus}<span>Adicionar linha</span></button>
    </section>
    <section class="panel calls-panel">
      <div class="panel-head"><h2>Chamadas</h2><span class="muted" id="calls-count"></span></div>
      <div id="conference"></div>
      <div id="calls" class="calls"></div>
    </section>
    <section class="panel side-panel">
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="dialer">Discador</button>
        <button role="tab" data-tab="history">Histórico <span class="badge" id="missed-badge" hidden></span></button>
      </div>
      <div id="tab-dialer" class="dialer">
        <label class="field">
          <span>Ligar pela linha</span>
          <select id="dial-line"></select>
        </label>
        <div class="dial-display">
          <input id="dial-input" inputmode="tel" autocomplete="off" placeholder="Número ou ramal" aria-label="Número" />
          <button class="icon-btn" id="dial-back" title="Apagar" aria-label="Apagar">${I.back}</button>
        </div>
        <div class="keypad">
          ${KEYS.map(([k, l]) => `<button class="key" data-dial="${k}"><b>${k}</b><small>${l || '&nbsp;'}</small></button>`).join('')}
        </div>
        <button class="call-btn" id="dial-call" title="Ligar" aria-label="Ligar">${I.phone}</button>
      </div>
      <div id="tab-history" class="history" hidden><div id="history-list"></div></div>
    </section>
  </main>
  <div id="modal-root"></div>
  <div id="toasts" class="toasts" aria-live="polite"></div>
  ${
    DEMO
      ? `<div class="demo-bar"><span>Modo demonstração${NATIVE ? '' : ' (navegador)'}</span><button class="btn btn-primary sm" id="demo-ring">${I.bell}<span>Simular chamada</span></button></div>`
      : ''
  }`;
}

/* ================= Renderização ================= */

function renderSummary() {
  const lines = [...phone.lines.values()];
  const online = lines.filter((l) => l.status === 'registered').length;
  const calls = [...phone.calls.values()];
  const ringing = calls.filter((c) => c.state === 'ringing').length;
  const talking = calls.length - ringing;
  const dnd = store.settings.dnd;
  $('#summary').innerHTML = `
    ${dnd ? `<span class="pill warn">${I.bellOff}Não perturbe</span>` : ''}
    <span class="pill"><i class="dot ${online ? 'ok' : ''}"></i>${online}/${lines.length} linhas online</span>
    ${talking ? `<span class="pill accent">${talking} em chamada</span>` : ''}
    ${ringing ? `<span class="pill ringing">${ringing} tocando</span>` : ''}`;
  const b = $('#btn-dnd');
  b.innerHTML = dnd ? I.bellOff : I.bell;
  b.classList.toggle('on-warn', !!dnd);
  b.title = dnd ? 'Não perturbe ativado — clique para desativar' : 'Ativar Não perturbe';
  $('#lines-count').textContent = lines.length ? `${online} de ${lines.length} online` : '';
  $('#calls-count').textContent = calls.length ? `${calls.length} ativa${calls.length > 1 ? 's' : ''}` : '';
}

function renderLines() {
  const lines = [...phone.lines.values()];
  if (!lines.length) {
    $('#lines').innerHTML = `<div class="empty small"><p>Nenhuma linha configurada.</p><p class="muted">Adicione uma conta SIP para receber e fazer chamadas.</p></div>`;
    return;
  }
  const perLine = {};
  for (const c of phone.calls.values()) perLine[c.accountId] = (perLine[c.accountId] || 0) + 1;
  $('#lines').innerHTML = lines
    .map(({ account: a, status, error }) => {
      const n = perLine[a.id] || 0;
      const fw = a.forward || {};
      const chips = [
        `<span class="chip">${esc(a.transport || 'UDP')}</span>`,
        `<span class="chip" title="Codecs desta linha, em ordem de preferência">${enabledCodecs(a.codecs).map((id) => esc(CODECS[id].short)).join(' · ')}</span>`,
        a.dnd ? `<span class="chip warn">Não perturbe</span>` : '',
        fw.mode && fw.mode !== 'off' && fw.target ? `<span class="chip">${I.forward}${esc(FWD[fw.mode])} → ${esc(fw.target)}</span>` : '',
        a.autoAnswer ? `<span class="chip">Atende sozinho</span>` : '',
      ].join('');
      return `
      <article class="line" style="--line:${esc(a.color)}">
        <div class="line-main">
          <div class="line-title"><strong>${esc(a.name || a.user)}</strong></div>
          <div class="line-sub">${esc(a.user)}@${esc(a.domain)}</div>
          <div class="line-meta">
            <span class="status s-${status}">${STATUS[status] || status}</span>
            ${n ? `<span class="muted">· ${n} chamada${n > 1 ? 's' : ''}</span>` : ''}
          </div>
          <div class="chips">${chips}</div>
          ${error && status === 'failed' ? `<div class="line-err">${esc(error)} <button class="link-btn" data-retry="${a.id}">Tentar agora</button></div>` : ''}
        </div>
        <div class="line-actions">
          <label class="switch" title="${a.enabled ? 'Desativar' : 'Ativar'} linha">
            <input type="checkbox" data-toggle="${a.id}" ${a.enabled ? 'checked' : ''} />
            <span></span>
          </label>
          <button class="icon-btn sm" data-edit="${a.id}" title="Editar linha" aria-label="Editar linha">${I.edit}</button>
        </div>
      </article>`;
    })
    .join('');
}

function renderConference() {
  const members = [...phone.calls.values()].filter((c) => c.conf);
  if (members.length < 2) {
    $('#conference').innerHTML = '';
    return;
  }
  const held = members.every((c) => c.held);
  $('#conference').innerHTML = `
    <div class="conf-bar">
      <div class="conf-info">${I.users}<div><strong>Conferência${held ? ' em espera' : ''}</strong>
        <span class="muted">${members.map((c) => esc(who(c))).join(' · ')}</span></div></div>
      <div class="row">
        <button class="btn btn-ghost sm" data-act="hold" data-id="${members[0].id}">${held ? I.play : I.pause}<span>${held ? 'Retomar' : 'Espera'}</span></button>
        <button class="btn btn-danger sm" data-act="end-conf">${I.hangup}<span>Encerrar</span></button>
      </div>
    </div>`;
}

function callOrder(a, b) {
  const r = (c) => (c.state === 'ringing' ? 0 : c.conf ? 1 : 2);
  return r(a) - r(b) || a.createdAt - b.createdAt;
}

function renderCalls() {
  renderConference();
  const calls = [...phone.calls.values()].sort(callOrder);
  if (!calls.length) {
    $('#calls').innerHTML = `
      <div class="empty">
        <div class="empty-art"><img src="./mark.png" alt="" /></div>
        <p><strong>Nenhuma chamada em andamento</strong></p>
        <p class="muted">Chamadas recebidas em qualquer linha aparecem aqui, mesmo simultaneamente.</p>
      </div>`;
    return;
  }
  $('#calls').innerHTML = calls.map(callCard).join('');
}

function callCard(c) {
  const title = esc(who(c));
  const sub = c.name ? esc(fmtNumber(c.number)) : '';
  const head = `
    <div class="call-who">
      <div class="avatar">${initials(c.name)}</div>
      <div class="call-id">
        <div class="call-name">${title}</div>
        ${sub ? `<div class="call-num">${sub}</div>` : ''}
      </div>`;
  const tag = `<div class="call-line"><i class="swatch"></i>${esc(lineName(c.accountId))}<span class="muted">· ${
    c.state === 'ringing' ? 'Chamada recebida' : c.direction === 'in' ? 'Recebida' : 'Efetuada'
  }</span>${c.conf ? '<span class="chip accent">Conferência</span>' : ''}</div>`;

  if (c.state === 'ringing') {
    return `
    <article class="call ringing" style="--line:${esc(colorOf(c.accountId))}">
      ${tag}
      ${head}</div>
      <div class="call-actions two">
        <button class="btn btn-danger" data-act="reject" data-id="${c.id}">${I.hangup}<span>Recusar</span></button>
        <button class="btn btn-primary" data-act="answer" data-id="${c.id}">${I.phone}<span>Atender</span></button>
      </div>
    </article>`;
  }

  const live = c.state === 'active' || c.state === 'held';
  const others = liveCalls().filter((o) => o.id !== c.id);
  const panel = ui.panel[c.id];
  const stateText = c.remoteHold && c.state === 'active' ? 'Em espera pelo outro lado' : CALL_STATE[c.state] || '';
  const timer = c.answeredAt ? `<span class="timer" data-since="${c.answeredAt}">${since(c.answeredAt)}</span>` : '';
  const consultOf = c.consultFor && phone.calls.get(c.consultFor);
  const consult = consultOf
    ? `<div class="consult">
         <span>Consulta para transferir <strong>${esc(who(consultOf))}</strong></span>
         <button class="btn btn-primary sm" data-act="complete-transfer" data-id="${c.id}" ${live ? '' : 'disabled'}>${I.transfer}<span>Concluir transferência</span></button>
       </div>`
    : '';
  const confBtn = c.conf
    ? `<button class="ctl" data-act="leave-conf" data-id="${c.id}">${I.split}<span>Separar</span></button>`
    : `<button class="ctl" data-act="merge" data-id="${c.id}" ${live && others.length ? '' : 'disabled'}>${I.users}<span>Conferência</span></button>`;

  return `
    <article class="call ${c.state}${c.conf ? ' in-conf' : ''}" style="--line:${esc(colorOf(c.accountId))}">
      ${tag}
      ${head}
        <div class="call-state"><span class="state-label">${stateText}</span>${timer}${c.codec ? `<span class="codec">${esc(c.codec)}</span>` : ''}</div>
      </div>
      ${consult}
      <div class="controls">
        <button class="ctl ${c.muted ? 'on' : ''}" data-act="mute" data-id="${c.id}" ${live ? '' : 'disabled'}>${c.muted ? I.micOff : I.mic}<span>Mudo</span></button>
        <button class="ctl ${c.held ? 'on' : ''}" data-act="hold" data-id="${c.id}" ${live ? '' : 'disabled'}>${c.held ? I.play : I.pause}<span>${c.held ? 'Retomar' : 'Espera'}</span></button>
        <button class="ctl ${panel === 'dtmf' ? 'on' : ''}" data-act="panel-dtmf" data-id="${c.id}" ${live ? '' : 'disabled'}>${I.keypad}<span>Teclado</span></button>
        <button class="ctl ${panel === 'transfer' ? 'on' : ''}" data-act="panel-transfer" data-id="${c.id}" ${live ? '' : 'disabled'}>${I.transfer}<span>Transferir</span></button>
        ${confBtn}
        <button class="ctl end" data-act="hangup" data-id="${c.id}">${I.hangup}<span>Encerrar</span></button>
      </div>
      ${
        live && panel === 'dtmf'
          ? `<div class="mini-keypad">${KEYS.map(([k]) => `<button class="key sm" data-act="dtmf" data-id="${c.id}" data-key="${k}">${k}</button>`).join('')}</div>`
          : ''
      }
      ${
        live && panel === 'transfer'
          ? `<form class="transfer" data-transfer="${c.id}">
               <input name="to" placeholder="Ramal ou número de destino" value="${esc(ui.transfer[c.id] || '')}" autocomplete="off" />
               <div class="row">
                 <button class="btn btn-primary sm" type="submit" name="mode" value="blind" title="Transfere imediatamente">Direta</button>
                 <button class="btn btn-outline sm" type="submit" name="mode" value="consult" title="Fala com o destino antes de transferir">Consultar</button>
               </div>
               ${
                 others.length
                   ? `<div class="xfer-list"><span class="muted small">Ou conectar com outra chamada (assistida):</span>
                      ${others
                        .map(
                          (o) =>
                            `<button type="button" class="xfer-item" data-act="attended" data-id="${c.id}" data-target="${o.id}"><i class="swatch" style="--line:${esc(colorOf(o.accountId))}"></i>${esc(who(o))}<span class="muted">${esc(lineName(o.accountId))}</span></button>`
                        )
                        .join('')}</div>`
                   : ''
               }
             </form>`
          : ''
      }
    </article>`;
}

function renderDialerLines() {
  const sel = $('#dial-line');
  const lines = [...phone.lines.values()];
  const usable = lines.filter((l) => l.status === 'registered');
  if (!usable.some((l) => l.account.id === ui.selectedLine)) ui.selectedLine = usable[0]?.account.id || null;
  sel.innerHTML = lines.length
    ? lines
        .map(
          (l) =>
            `<option value="${l.account.id}" ${l.status !== 'registered' ? 'disabled' : ''} ${l.account.id === ui.selectedLine ? 'selected' : ''}>${esc(
              l.account.name || l.account.user
            )} (${esc(l.account.user)})${l.status !== 'registered' ? ` — ${STATUS[l.status]}` : ''}</option>`
        )
        .join('')
    : '<option value="">Nenhuma linha configurada</option>';
  sel.style.setProperty('--line', ui.selectedLine ? colorOf(ui.selectedLine) : 'transparent');
  $('#dial-call').disabled = !ui.selectedLine;
}

function renderHistory() {
  const missed = store.history.filter((h) => h.result === 'missed' && !h.seen).length;
  const badge = $('#missed-badge');
  badge.hidden = !missed;
  badge.textContent = missed;
  if (ui.tab !== 'history') return;
  const list = store.history;
  if (!list.length) {
    $('#history-list').innerHTML = `<div class="empty small"><p class="muted">Nenhuma chamada registrada ainda.</p></div>`;
    return;
  }
  $('#history-list').innerHTML = `
    <div class="history-head"><span class="muted">${list.length} registro${list.length > 1 ? 's' : ''}</span>
      <button class="link-btn" id="clear-history">Limpar</button></div>
    ${list
      .map((h) => {
        const d = new Date(h.at);
        const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const when = new Date().toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hm}`;
        const bad = ['missed', 'failed'].includes(h.result);
        return `
        <button class="h-item" data-redial="${esc(h.number)}" data-line="${esc(h.accountId)}" title="Ligar de volta">
            <span class="h-dir ${bad ? 'bad' : ''}">${h.direction === 'in' ? I.inbound : I.outbound}</span>
            <span class="h-main">
              <span class="h-name">${esc(h.name || fmtNumber(h.number))}</span>
              <span class="h-sub"><i class="swatch" style="--line:${esc(colorOf(h.accountId))}"></i>${esc(h.lineName)} · ${RESULT[h.result] || h.result}${
          h.duration ? ` · ${fmtDur(h.duration)}` : ''
        }${h.cause ? ` · ${esc(h.cause)}` : ''}</span>
            </span>
            <span class="h-when">${when}</span>
        </button>`;
      })
      .join('')}`;
}

function renderTabs() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === ui.tab));
  $('#tab-dialer').hidden = ui.tab !== 'dialer';
  $('#tab-history').hidden = ui.tab !== 'history';
  if (ui.tab === 'history') store.history.forEach((h) => (h.seen = true));
}

function renderAll() {
  renderSummary();
  renderLines();
  renderCalls();
  renderDialerLines();
  renderTabs();
  renderHistory();
  updateRinger();
}

function updateRinger() {
  const calls = [...phone.calls.values()];
  const ringing = calls.some((c) => c.state === 'ringing');
  const busy = calls.some((c) => c.state !== 'ringing');
  const ringback = calls.some((c) => c.state === 'ringback' && !c.early);
  setRinger(ringing ? (busy ? 'waiting' : 'ring') : ringback ? 'ringback' : null);
  document.title = ringing ? '📞 Chamada recebida — Vincii Anunciação' : 'Vincii Anunciação';
}

/* ================= Tema ================= */

const THEMES = { system: 'Sistema', light: 'Claro', dark: 'Escuro' };
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = ui.themePreview || store.settings.theme || 'dark';
  window.vincii?.app.setTheme(pref);
  const resolved = pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  const b = $('#btn-theme');
  if (b) {
    b.innerHTML = pref === 'system' ? I.monitor : pref === 'light' ? I.sun : I.moon;
    b.title = `Tema: ${THEMES[pref]} (clique para alternar)`;
  }
}

function setTheme(pref) {
  store.settings.theme = pref;
  store.saveSettings();
  applyTheme();
}

/* ================= Toasts / Modal ================= */

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4200);
}

function openModal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => {
    root.innerHTML = '';
    ui.themePreview = null; // desfaz a prévia de tema não salva
    applyTheme();
  };
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) close();
  });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  onMount?.(root.querySelector('.modal'), close);
  root.querySelector('input, select')?.focus();
}

const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;

function accountModal(id) {
  const existing = store.accounts.find((a) => a.id === id);
  const a = existing || { ...ACCOUNT_DEFAULTS, color: COLORS[store.accounts.length % COLORS.length] };
  const fw = a.forward || ACCOUNT_DEFAULTS.forward;
  openModal(
    `
    <form class="form" id="acc-form" novalidate>
      <div class="modal-head">
        <h3>${existing ? 'Editar linha' : 'Nova linha'}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Fechar">${I.close}</button>
      </div>
      <div class="grid2">
        <label class="field"><span>Nome da linha</span><input name="name" value="${esc(a.name)}" placeholder="Ex.: Suporte, Provedor X" /></label>
        <div class="field"><span>Cor</span>
          <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === a.color ? 'checked' : ''} /><i style="--c:${c}"></i></label>`).join('')}</div>
        </div>
        <label class="field"><span>Ramal / usuário SIP *</span><input name="user" value="${esc(a.user)}" placeholder="1001" required /></label>
        <label class="field"><span>Domínio / servidor SIP *</span><input name="domain" value="${esc(a.domain)}" placeholder="pbx.suaempresa.com.br" required /></label>
        <label class="field"><span>Senha</span><input name="password" type="password" value="${esc(a.password)}" autocomplete="new-password" /></label>
        <label class="field"><span>Transporte</span><select name="transport">${['UDP', 'TCP', 'TLS'].map((t) => opt(t, t, a.transport)).join('')}</select></label>
      </div>

      <details ${existing && (a.proxy || a.authUser) ? 'open' : ''}>
        <summary>Avançado</summary>
        <div class="grid2">
          <label class="field"><span>Proxy de saída</span><input name="proxy" value="${esc(a.proxy)}" placeholder="Opcional — host:porta" /></label>
          <label class="field"><span>Usuário de autenticação</span><input name="authUser" value="${esc(a.authUser)}" placeholder="Opcional (padrão: ramal)" /></label>
          <label class="field"><span>Nome de exibição</span><input name="displayName" value="${esc(a.displayName)}" placeholder="Opcional" /></label>
          <label class="field"><span>Expiração do registro (s)</span><input name="expires" type="number" min="60" max="3600" value="${esc(a.expires)}" /></label>
        </div>
        <label class="check"><input type="checkbox" name="natDetect" ${a.natDetect !== false ? 'checked' : ''} /> Detectar IP público atrás de NAT (rport)</label>
        <label class="check"><input type="checkbox" name="tlsVerify" ${a.tlsVerify !== false ? 'checked' : ''} /> Verificar certificado TLS do servidor</label>
      </details>

      <details open>
        <summary>Codecs</summary>
        <p class="muted small">Marque os codecs que esta linha pode usar. O primeiro da lista é o preferido; use as setas para mudar a ordem.</p>
        <ul class="codec-list" id="codec-list">
          ${normalizeCodecs(a.codecs)
            .map(
              (c) => `
            <li data-codec="${c.id}">
              <label class="codec-check">
                <input type="checkbox" ${c.on ? 'checked' : ''} ${c.id === 'opus' && !opusSupported() ? 'disabled' : ''} />
                <span><b>${esc(CODECS[c.id].label)}</b><small>${esc(CODECS[c.id].desc)}</small></span>
              </label>
              <span class="codec-rank"></span>
              <div class="codec-move">
                <button type="button" class="icon-btn sm" data-move="-1" title="Subir" aria-label="Subir">${I.up}</button>
                <button type="button" class="icon-btn sm" data-move="1" title="Descer" aria-label="Descer">${I.down}</button>
              </div>
            </li>`
            )
            .join('')}
        </ul>
      </details>

      <details ${existing && ((fw.mode && fw.mode !== 'off') || a.dnd || a.autoAnswer) ? 'open' : ''}>
        <summary>Desvio e atendimento</summary>
        <div class="grid3">
          <label class="field"><span>Desviar chamadas</span><select name="fwMode">${Object.entries(FWD).map(([k, v]) => opt(k, v, fw.mode)).join('')}</select></label>
          <label class="field"><span>Para o número</span><input name="fwTarget" value="${esc(fw.target)}" placeholder="Ramal ou número" /></label>
          <label class="field"><span>Após (s)</span><input name="fwSeconds" type="number" min="5" max="120" value="${esc(fw.seconds)}" /></label>
        </div>
        <label class="check"><input type="checkbox" name="dnd" ${a.dnd ? 'checked' : ''} /> Não perturbe nesta linha (recusa como ocupado)</label>
        <label class="check"><input type="checkbox" name="autoAnswer" ${a.autoAnswer ? 'checked' : ''} /> Atender automaticamente (quando livre)</label>
      </details>

      <label class="check"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''} /> Linha ativa (registrar ao salvar)</label>
      <p class="form-err" id="acc-err" hidden></p>
      <div class="modal-foot">
        ${existing ? `<button type="button" class="btn btn-ghost danger" id="acc-del">${I.trash}<span>Excluir</span></button>` : '<span></span>'}
        <div class="row">
          <button type="button" class="btn btn-ghost" data-close>Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </div>
    </form>`,
    (modal, close) => {
      const form = modal.querySelector('form');
      const list = modal.querySelector('#codec-list');
      const rank = () =>
        [...list.children].forEach((li, i) => {
          const on = li.querySelector('input').checked;
          li.classList.toggle('off', !on);
          li.querySelector('.codec-rank').textContent = on ? `${[...list.children].slice(0, i + 1).filter((x) => x.querySelector('input').checked).length}º` : '—';
          li.querySelector('[data-move="-1"]').disabled = i === 0;
          li.querySelector('[data-move="1"]').disabled = i === list.children.length - 1;
        });
      list.addEventListener('change', rank);
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-move]');
        if (!b) return;
        const li = b.closest('li');
        if (b.dataset.move === '-1' && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling);
        else if (b.dataset.move === '1' && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li);
        rank();
        b.focus();
      });
      rank();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        const codecs = [...list.children].map((li) => ({ id: li.dataset.codec, on: li.querySelector('input').checked }));
        const data = {
          ...ACCOUNT_DEFAULTS,
          id: existing?.id || uid(),
          name: f.name.trim(),
          color: f.color || COLORS[0],
          user: f.user.trim(),
          domain: f.domain.trim().replace(/^sips?:/i, ''),
          password: f.password,
          transport: f.transport,
          proxy: f.proxy.trim(),
          authUser: f.authUser.trim(),
          displayName: f.displayName.trim(),
          expires: Math.min(3600, Math.max(60, Number(f.expires) || 300)),
          natDetect: !!f.natDetect,
          tlsVerify: !!f.tlsVerify,
          dnd: !!f.dnd,
          autoAnswer: !!f.autoAnswer,
          forward: { mode: f.fwMode, target: f.fwTarget.trim(), seconds: Math.min(120, Math.max(5, Number(f.fwSeconds) || 20)) },
          codecs,
          enabled: !!f.enabled,
        };
        const err = !data.user
          ? 'Informe o ramal/usuário SIP.'
          : !codecs.some((c) => c.on)
            ? 'Marque pelo menos um codec.'
          : !data.domain
            ? 'Informe o domínio ou servidor SIP.'
            : data.forward.mode !== 'off' && !data.forward.target
              ? 'Informe o número para onde desviar.'
              : '';
        if (err) {
          const p = modal.querySelector('#acc-err');
          p.textContent = err;
          p.hidden = false;
          return;
        }
        if (existing) Object.assign(existing, data);
        else store.accounts.push(data);
        await store.saveAccounts();
        phone.syncAccounts();
        close();
        toast(existing ? 'Linha atualizada' : 'Linha adicionada', 'ok');
      });
      modal.querySelector('#acc-del')?.addEventListener('click', async () => {
        const busy = [...phone.calls.values()].some((c) => c.accountId === existing.id);
        const msg = busy
          ? `A linha "${existing.name || existing.user}" tem chamadas em andamento, que serão encerradas. Excluir mesmo assim?`
          : `Excluir a linha "${existing.name || existing.user}"?`;
        if (!confirm(msg)) return;
        store.accounts = store.accounts.filter((x) => x.id !== existing.id);
        await store.saveAccounts();
        phone.syncAccounts();
        close();
        toast('Linha excluída');
      });
    }
  );
}


async function settingsModal() {
  const s = store.settings;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    /* sem suporte */
  }
  const sys = NATIVE ? await window.vincii.app.getSystem() : null;
  const needsPermission = devices.some((d) => d.kind === 'audioinput' && !d.label);
  const devOpts = (kind, current) =>
    opt('', 'Padrão do sistema', current) +
    devices
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
      .map((d, i) => opt(d.deviceId, d.label || `Dispositivo ${i + 1}`, current))
      .join('');
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const chk = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} /> ${label}</label>`;

  openModal(
    `
    <form class="form" id="set-form">
      <div class="modal-head">
        <h3>Configurações</h3>
        <button type="button" class="icon-btn" data-close aria-label="Fechar">${I.close}</button>
      </div>

      <h4>Aparência</h4>
      <div class="segmented" role="radiogroup" aria-label="Tema">
        ${Object.entries(THEMES)
          .map(
            ([k, v]) =>
              `<label><input type="radio" name="theme" value="${k}" ${(s.theme || 'dark') === k ? 'checked' : ''} /><span>${
                k === 'system' ? I.monitor : k === 'light' ? I.sun : I.moon
              }${v}</span></label>`
          )
          .join('')}
      </div>

      <h4>Áudio</h4>
      ${needsPermission ? `<div class="notice">Permita o acesso ao microfone para ver os nomes dos dispositivos. <button type="button" class="link-btn" id="ask-mic">Permitir</button></div>` : ''}
      <div class="grid2">
        <label class="field"><span>Microfone</span><select name="micId">${devOpts('audioinput', s.micId)}</select></label>
        <label class="field"><span>Alto-falante / fone</span><select name="speakerId">${devOpts('audiooutput', s.speakerId)}</select></label>
      </div>
      ${chk('echoCancellation', s.echoCancellation, 'Cancelamento de eco')}
      ${chk('noiseSuppression', s.noiseSuppression, 'Supressão de ruído')}
      ${chk('autoGainControl', s.autoGainControl, 'Controle automático de ganho')}

      <h4>Chamadas</h4>
      <div class="grid2">
        <label class="field"><span>Envio de DTMF</span><select name="dtmfMode">${opt('rfc2833', 'RFC 2833 / 4733 (RTP)', s.dtmfMode)}${opt('info', 'SIP INFO', s.dtmfMode)}</select></label>
      </div>
      ${chk('autoHold', s.autoHold, 'Colocar outras chamadas em espera ao atender ou retomar uma chamada')}

      <h4>Rede</h4>
      <div class="grid2">
        <label class="field"><span>Portas RTP — início</span><input name="rtpMin" type="number" min="1024" max="65000" value="${esc(s.rtpMin)}" /></label>
        <label class="field"><span>Portas RTP — fim</span><input name="rtpMax" type="number" min="1026" max="65534" value="${esc(s.rtpMax)}" /></label>
      </div>

      ${
        sys
          ? `<h4>Sistema</h4>
             ${chk('startAtLogin', sys.startAtLogin, 'Iniciar com o sistema')}
             ${chk('startHidden', sys.startHidden, 'Ao iniciar com o sistema, abrir minimizado na bandeja')}
             ${chk('closeToTray', sys.closeToTray, 'Fechar a janela mantém o app rodando na bandeja')}
             ${chk('showOnIncoming', sys.showOnIncoming, 'Mostrar a janela ao receber uma chamada')}`
          : ''
      }

      ${
        NATIVE
          ? `<h4>Diagnóstico</h4>
             <div class="notice">As mensagens SIP de todas as linhas são gravadas em arquivo (senhas ocultas) para investigar falhas. <button type="button" class="link-btn" id="open-logs">Abrir pasta de logs</button></div>`
          : ''
      }

      <h4>Notificações</h4>
      ${chk('quietWhenBusy', s.quietWhenBusy !== false, 'Não interromper durante ligações: nova chamada aparece só no app, com um bipe discreto (sem pop-up, sem a janela saltar)')}
      <div class="notice">${
        notif === 'granted'
          ? 'Notificações de chamada recebida ativadas.'
          : notif === 'denied'
            ? 'Notificações bloqueadas.'
            : notif === 'unsupported'
              ? 'Notificações não suportadas.'
              : `Receba um alerta quando tocar com a janela em segundo plano. <button type="button" class="link-btn" id="ask-notif">Ativar</button>`
      }</div>

      <div class="modal-foot">
        <span class="muted small">${DEMO ? 'Modo demonstração' : 'Vincii Anunciação 2.5'}</span>
        <div class="row">
          <button type="button" class="btn btn-ghost" data-close>Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </div>
    </form>`,
    (modal, close) => {
      // Prévia do tema enquanto a janela está aberta; só grava ao salvar.
      modal.querySelectorAll('input[name="theme"]').forEach((r) =>
        r.addEventListener('change', () => {
          ui.themePreview = r.value;
          applyTheme();
        })
      );
      modal.querySelector('#open-logs')?.addEventListener('click', () => window.vincii.log.open());
      modal.querySelector('#ask-mic')?.addEventListener('click', async () => {
        try {
          const st = await navigator.mediaDevices.getUserMedia({ audio: true });
          st.getTracks().forEach((t) => t.stop());
          close();
          settingsModal();
        } catch {
          toast('Acesso ao microfone negado', 'error');
        }
      });
      modal.querySelector('#ask-notif')?.addEventListener('click', async () => {
        await Notification.requestPermission();
        close();
        settingsModal();
      });
      modal.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const micChanged = f.micId !== s.micId || !!f.echoCancellation !== s.echoCancellation || !!f.noiseSuppression !== s.noiseSuppression || !!f.autoGainControl !== s.autoGainControl;
        const speakerChanged = f.speakerId !== s.speakerId;
        const rtpMin = Math.max(1024, Number(f.rtpMin) || 10000);
        Object.assign(s, {
          micId: f.micId || '',
          speakerId: f.speakerId || '',
          echoCancellation: !!f.echoCancellation,
          noiseSuppression: !!f.noiseSuppression,
          autoGainControl: !!f.autoGainControl,
          dtmfMode: f.dtmfMode,
          autoHold: !!f.autoHold,
          quietWhenBusy: !!f.quietWhenBusy,
          rtpMin,
          rtpMax: Math.max(rtpMin + 2, Number(f.rtpMax) || 20000),
        });
        s.theme = f.theme || 'dark';
        ui.themePreview = null;
        store.saveSettings();
        applyTheme();
        if (phone.engine) {
          if (speakerChanged) phone.engine.setSpeaker(s.speakerId);
          if (micChanged) phone.engine.restartMic().catch(() => toast('Não foi possível reabrir o microfone', 'error'));
        }
        if (sys) {
          await window.vincii.app.setSystem({
            startAtLogin: !!f.startAtLogin,
            startHidden: !!f.startHidden,
            closeToTray: !!f.closeToTray,
            showOnIncoming: !!f.showOnIncoming,
          });
        }
        close();
        toast('Configurações salvas', 'ok');
      });
    }
  );
}

/* ================= Ações ================= */

function safe(fn) {
  try {
    const r = fn();
    if (r?.catch) r.catch((err) => toast(err.message || String(err), 'error'));
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
}

function dial() {
  const input = $('#dial-input');
  safe(() => {
    phone.call(ui.selectedLine, input.value);
    input.value = '';
  });
}

function bindEvents() {
  const dialInput = $('#dial-input');
  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-tab]');
    if (!t || (t.type === 'submit' && t.form)) return;

    if (t.dataset.tab) {
      ui.tab = t.dataset.tab;
      renderTabs();
      renderHistory();
      return;
    }
    if (t.dataset.dial) {
      dtmfTone(t.dataset.dial);
      dialInput.value += t.dataset.dial;
      return;
    }
    if (t.dataset.edit) return accountModal(t.dataset.edit);
    if (t.dataset.retry) return phone.reconnect(t.dataset.retry);
    if (t.dataset.redial !== undefined) {
      dialInput.value = t.dataset.redial;
      if (lineOf(t.dataset.line)?.status === 'registered') ui.selectedLine = t.dataset.line;
      ui.tab = 'dialer';
      renderAll();
      dialInput.focus();
      return;
    }

    const id = t.dataset.id;
    switch (t.dataset.act) {
      case 'answer':
        return safe(() => phone.answer(id));
      case 'reject':
        return safe(() => phone.reject(id));
      case 'hangup':
        return safe(() => phone.hangup(id));
      case 'mute':
        return safe(() => phone.toggleMute(id));
      case 'hold':
        return safe(() => phone.toggleHold(id));
      case 'merge':
        return safe(() => phone.mergeConference());
      case 'leave-conf':
        return safe(() => phone.leaveConference(id));
      case 'end-conf':
        return safe(() => phone.endConference());
      case 'attended':
        ui.panel[id] = null;
        return safe(() => phone.attendedTransfer(id, t.dataset.target));
      case 'complete-transfer': {
        const c = phone.calls.get(id);
        return safe(() => phone.attendedTransfer(c.consultFor, id));
      }
      case 'dtmf':
        dtmfTone(t.dataset.key);
        return safe(() => phone.dtmf(id, t.dataset.key));
      case 'panel-dtmf':
      case 'panel-transfer': {
        const p = t.dataset.act.slice(6);
        ui.panel[id] = ui.panel[id] === p ? null : p;
        renderCalls();
        if (ui.panel[id] === 'transfer') $(`[data-transfer="${id}"] input`)?.focus();
        return;
      }
    }

    switch (t.id) {
      case 'btn-add-line':
        return accountModal();
      case 'btn-settings':
        return settingsModal();
      case 'btn-theme': {
        const order = ['system', 'light', 'dark'];
        const next = order[(order.indexOf(store.settings.theme || 'dark') + 1) % 3];
        setTheme(next);
        toast(`Tema: ${THEMES[next]}`);
        return;
      }
      case 'btn-dnd':
        phone.setDnd(!store.settings.dnd);
        toast(store.settings.dnd ? 'Não perturbe ativado: chamadas serão recusadas' : 'Não perturbe desativado', store.settings.dnd ? 'warn' : 'ok');
        return;
      case 'dial-back':
        dialInput.value = dialInput.value.slice(0, -1);
        return;
      case 'dial-call':
        return dial();
      case 'clear-history':
        if (confirm('Limpar todo o histórico de chamadas?')) {
          store.clearHistory();
          renderHistory();
        }
        return;
      case 'demo-ring': {
        const online = [...phone.lines.values()].filter((l) => l.status === 'registered');
        if (!online.length) return toast('Ative ao menos uma linha', 'error');
        const line = online[Math.floor(Math.random() * online.length)];
        const [num, name] = randomCaller();
        phone.simulateIncoming(line.account.id, num, name);
      }
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.dataset.toggle) {
      const acc = store.accounts.find((a) => a.id === e.target.dataset.toggle);
      if (!acc) return;
      acc.enabled = e.target.checked;
      await store.saveAccounts();
      phone.syncAccounts();
    }
    if (e.target.id === 'dial-line') {
      ui.selectedLine = e.target.value;
      renderDialerLines();
    }
  });

  document.addEventListener('input', (e) => {
    const f = e.target.closest('[data-transfer]');
    if (f) ui.transfer[f.dataset.transfer] = e.target.value;
  });

  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-transfer]');
    if (!f) return;
    e.preventDefault();
    const id = f.dataset.transfer;
    const to = f.elements.to.value;
    const mode = e.submitter?.value || 'blind';
    safe(() => {
      if (mode === 'consult') phone.consult(id, to);
      else phone.transfer(id, to);
      ui.panel[id] = null;
      ui.transfer[id] = '';
      renderCalls();
    });
  });

  dialInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dial();
  });

  document.addEventListener('keydown', (e) => {
    if ($('#modal-root').children.length) {
      if (e.key === 'Escape') {
        $('#modal-root').innerHTML = '';
        ui.themePreview = null;
        applyTheme();
      }
      return;
    }
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9*#+]$/.test(e.key)) {
      ui.tab = 'dialer';
      renderTabs();
      dtmfTone(e.key);
      dialInput.value += e.key;
    } else if (e.key === 'Backspace') {
      dialInput.value = dialInput.value.slice(0, -1);
    } else if (e.key === 'Enter' && dialInput.value) {
      dial();
    }
  });

  phone.addEventListener('change', renderAll);
  phone.addEventListener('history', renderHistory);
  phone.addEventListener('incoming', ({ detail: call }) => {
    if (store.settings.quietWhenBusy && phone.inCall()) return; // só o cartão e o bipe de chamada em espera
    if (!document.hasFocus() && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`Chamada recebida — ${lineName(call.accountId)}`, {
        body: call.name ? `${call.name} · ${fmtNumber(call.number)}` : fmtNumber(call.number),
        icon: './logo.png',
        tag: call.id,
        requireInteraction: true,
      });
      n.onclick = () => {
        window.vincii?.app.show();
        window.focus();
        n.close();
      };
      phone.addEventListener('change', function closeWhenDone() {
        if (phone.calls.get(call.id)?.state !== 'ringing') {
          n.close();
          phone.removeEventListener('change', closeWhenDone);
        }
      });
    }
  });
  phone.addEventListener('ended', ({ detail: { call, result } }) => {
    delete ui.panel[call.id];
    delete ui.transfer[call.id];
    if (result === 'failed') toast(`${who(call)}: ${call.cause || 'Falha na chamada'}`, 'error');
    else if (result === 'missed') toast(`Chamada perdida de ${who(call)}`, 'warn');
    else if (result === 'forwarded') toast(`${who(call)} — ${call.cause}`);
  });
  phone.addEventListener('notice', ({ detail }) => toast(detail, 'ok'));
  phone.addEventListener('error', ({ detail }) => toast(detail, 'error'));

  if (NATIVE) {
    window.vincii.app.onDial((number) => {
      ui.tab = 'dialer';
      renderTabs();
      dialInput.value = number;
      dialInput.focus();
      toast(`Número recebido: ${number} — confira a linha e clique em ligar`);
    });
    window.vincii.app.onDnd((on) => phone.setDnd(on));
  }

  setInterval(() => {
    document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = since(Number(el.dataset.since))));
  }, 1000);

  window.addEventListener('beforeunload', () => phone.stopAll());
}

async function start() {
  loadG729(); // carrega o G.729 (WebAssembly) em segundo plano
  await store.unlock();
  if (DEMO && !store.accounts.length) seedDemo(store);
  phone = new Phone(store, { bridge: DEMO ? null : window.vincii, demo: DEMO });
  if (import.meta.env.DEV || DEMO) window.vinciiDebug = { phone, store }; // inspeção só em desenvolvimento
  document.body.classList.add(`platform-${window.vincii?.platform || 'web'}`);
  applyTheme();
  darkQuery.addEventListener('change', applyTheme);
  shell();
  applyTheme();
  bindEvents();
  phone.syncAccounts();
  if (!store.accounts.length) accountModal();
}

start();

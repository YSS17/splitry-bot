require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { enviarMensagem } = require('./meta');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 } });
app.use('/uploads', express.static(uploadDir));

// ─── Webhook Meta ─────────────────────────────────────────────
app.get('/webhook/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;
        for (const msg of value.messages) {
          if (msg.type !== 'text') continue;
          const from = msg.from;
          const text = msg.text.body;
          const nome = (value.contacts || []).find(c => c.wa_id === from)?.profile?.name || null;
          console.log(`[${new Date().toISOString()}] ${from} (${nome}): ${text}`);
          const { handleMetaMessage } = require('./bot');
          await handleMetaMessage(from, text, nome);
        }
      }
    }
  } catch (err) { console.error('Erro webhook:', err); }
});

// ─── API: dados do rateio ─────────────────────────────────────
app.get('/api/r/:codigo', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Rateio não encontrado' });
    const [membros, gastos, saldo] = await Promise.all([
      db.getMembros(grupo.id),
      db.getGastos(grupo.id),
      db.getSaldoGrupo(grupo.id)
    ]);
    const gastosComParticipantes = await Promise.all(gastos.map(async g => ({
      ...g, participantes: await db.getParticipantes(g.id)
    })));
    res.json({ grupo, membros, gastos: gastosComParticipantes, saldo });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// ─── API: adicionar gasto ─────────────────────────────────────
app.post('/api/r/:codigo/gasto', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });

    const { descricao, valor, proposto_por_telefone, proposto_por_nome, participantes_excluidos } = req.body;
    const membros = await db.getMembros(grupo.id);
    const ehCriador = grupo.criado_por === proposto_por_telefone;

    // Filtra participantes (exclui quem foi marcado para excluir)
    const excluidos = participantes_excluidos ? JSON.parse(participantes_excluidos) : [];
    const participantes = membros
      .filter(m => !excluidos.includes(m.telefone))
      .map(m => ({ telefone: m.telefone, nome: m.nome, valor: parseFloat(valor) / (membros.length - excluidos.length) }));

    // Criador: aprovado direto. Outros: pendente de aprovação
    const status = ehCriador ? 'aprovado' : 'pendente';
    const gastoId = await db.criarGasto(grupo.id, descricao, parseFloat(valor), proposto_por_telefone, proposto_por_nome, participantes, status);

    // Notifica criador se não for ele quem propôs
    if (!ehCriador) {
      const base = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
      await enviarMensagem(grupo.criado_por,
        `📋 *${proposto_por_nome}* propôs um gasto de R$${parseFloat(valor).toFixed(2)} em "${descricao}"\n\nAprove ou rejeite na página:\n${base}/r/${grupo.codigo}`
      ).catch(() => {});
    }

    res.json({ ok: true, gastoId, status });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// ─── API: aprovar/rejeitar gasto ──────────────────────────────
app.post('/api/r/:codigo/gasto/:gastoId/aprovar', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone } = req.body;
    if (grupo.criado_por !== telefone) return res.status(403).json({ error: 'Apenas o criador pode aprovar' });
    await db.aprovarGasto(req.params.gastoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/rejeitar', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone } = req.body;
    if (grupo.criado_por !== telefone) return res.status(403).json({ error: 'Apenas o criador pode rejeitar' });
    await db.rejeitarGasto(req.params.gastoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

// ─── API: confirmar pagamento ─────────────────────────────────
app.post('/api/r/:codigo/gasto/:gastoId/confirmar', upload.single('comprovante'), async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone, nome } = req.body;
    const comprovanteUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await db.confirmarPagamento(req.params.gastoId, telefone, comprovanteUrl);

    // Notifica criador
    const gasto = await db.getGasto(req.params.gastoId);
    if (gasto) {
      const base = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
      await enviarMensagem(grupo.criado_por,
        `💰 *${nome}* confirmou pagamento de "${gasto.descricao}"\n${comprovanteUrl ? 'Comprovante anexado.' : 'Sem comprovante.'}\n\nValide na página:\n${base}/r/${grupo.codigo}`
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

// ─── API: validar/rejeitar pagamento ─────────────────────────
app.post('/api/r/:codigo/gasto/:gastoId/validar', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone_criador, telefone_devedor, nome_devedor } = req.body;
    if (grupo.criado_por !== telefone_criador) return res.status(403).json({ error: 'Apenas o criador pode validar' });
    await db.validarPagamento(req.params.gastoId, telefone_devedor);

    // Notifica devedor
    await enviarMensagem(telefone_devedor,
      `✅ Seu pagamento foi confirmado pelo organizador!`
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/rejeitar-pagamento', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone_criador, telefone_devedor } = req.body;
    if (grupo.criado_por !== telefone_criador) return res.status(403).json({ error: 'Apenas o criador pode rejeitar' });
    await db.rejeitarPagamento(req.params.gastoId, telefone_devedor);

    await enviarMensagem(telefone_devedor,
      `⚠️ Seu comprovante foi rejeitado. Por favor, envie novamente na página do rateio.`
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

// ─── SPA ──────────────────────────────────────────────────────
app.get('/r/:codigo', (req, res) => {
  res.send(buildSPA(req.params.codigo));
});

app.get('/', (_req, res) => res.send('Splitry rodando!'));

function buildSPA(codigo) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Splitry</title>
  <style>
    :root{
      --green:#16a34a;--green-d:#15803d;--green-l:#dcfce7;--green-m:#22c55e;
      --red:#dc2626;--red-l:#fee2e2;--amber:#d97706;--amber-l:#fef3c7;
      --gray:#6b7280;--bg:#f0fdf4;--white:#fff;--border:#e5e7eb;
      --shadow:0 2px 8px rgba(0,0,0,.06);--radius:14px;
    }
    *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:#111;min-height:100vh;padding-bottom:80px}
    /* Header */
    .header{background:linear-gradient(135deg,var(--green-d),var(--green));color:#fff;padding:20px 16px 28px}
    .header-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    .logo{font-size:12px;font-weight:700;letter-spacing:2px;opacity:.8;text-transform:uppercase}
    .codigo-pill{background:rgba(255,255,255,.2);padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:1px}
    .header h1{font-size:22px;font-weight:700}
    .header-sub{font-size:13px;opacity:.75;margin-top:2px}
    /* Stats */
    .stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 14px;margin-top:-18px;position:relative;z-index:2}
    .stat{background:var(--white);border-radius:var(--radius);padding:14px;box-shadow:var(--shadow)}
    .stat-label{font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
    .stat-value{font-size:22px;font-weight:700}
    .stat-value.g{color:var(--green)}.stat-value.r{color:var(--red)}
    /* Tabs */
    .tabs{display:flex;padding:14px 14px 0;gap:6px;position:sticky;top:0;background:var(--bg);z-index:10;padding-top:12px}
    .tab{flex:1;padding:9px 4px;border-radius:10px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:var(--white);color:var(--gray);transition:all .15s}
    .tab.active{background:var(--green);color:#fff}
    /* Container */
    .container{padding:12px 14px;max-width:520px;margin:0 auto}
    /* Quem sou */
    .who-bar{background:var(--white);border-radius:var(--radius);padding:12px 14px;display:flex;align-items:center;gap:10px;margin-bottom:12px;box-shadow:var(--shadow)}
    .who-bar select{flex:1;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:13px;background:var(--bg);color:#111;outline:none}
    .who-label{font-size:12px;color:var(--gray);white-space:nowrap}
    /* Saldo */
    .saldo-card{background:var(--white);border-radius:var(--radius);padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;gap:10px;box-shadow:var(--shadow)}
    .av{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;flex-shrink:0}
    .av.g{background:var(--green)}.av.r{background:var(--red)}.av.a{background:var(--amber)}
    .saldo-info{flex:1;min-width:0}
    .saldo-nome{font-weight:600;font-size:14px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .saldo-sub{font-size:12px;color:var(--gray)}
    .saldo-val{font-weight:700;color:var(--red);white-space:nowrap;font-size:15px}
    /* Gastos */
    .gasto-card{background:var(--white);border-radius:var(--radius);margin-bottom:10px;overflow:hidden;box-shadow:var(--shadow)}
    .gasto-head{display:flex;align-items:center;gap:10px;padding:14px}
    .gasto-icon{width:42px;height:42px;border-radius:10px;background:var(--green-l);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
    .gasto-meta{flex:1;min-width:0}
    .gasto-desc{font-weight:600;font-size:15px;display:block}
    .gasto-by{font-size:12px;color:var(--gray)}
    .gasto-total{font-weight:700;font-size:16px;white-space:nowrap}
    .status-pill{display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;margin-left:8px}
    .sp-pendente{background:var(--amber-l);color:var(--amber)}
    .sp-aprovado{background:var(--green-l);color:var(--green)}
    .sp-rejeitado{background:var(--red-l);color:var(--red)}
    .prog-bar{height:3px;background:var(--border);margin:0 14px 4px}
    .prog-fill{height:100%;background:var(--green-m);border-radius:2px;transition:width .4s}
    .prog-lbl{font-size:11px;color:var(--gray);padding:0 14px 8px;text-align:right}
    .parts-list{border-top:1px solid var(--border)}
    .part-row{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border)}
    .part-row:last-child{border-bottom:none}
    .part-av{width:30px;height:30px;border-radius:50%;background:var(--green-l);color:var(--green);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0}
    .part-info{flex:1;min-width:0}
    .part-nome{font-size:13px;font-weight:500;display:block}
    .part-val{font-size:12px;color:var(--gray)}
    .part-actions{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
    .badge{font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;white-space:nowrap}
    .badge.pago{background:var(--green-l);color:var(--green)}
    .badge.aguard{background:var(--amber-l);color:var(--amber)}
    .badge.pend{background:var(--border);color:var(--gray)}
    .btn-sm{border:none;border-radius:20px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
    .btn-green{background:var(--green);color:#fff}
    .btn-red{background:var(--red);color:#fff}
    .btn-amber{background:var(--amber);color:#fff}
    .btn-ghost{background:var(--border);color:#333}
    .ver-comp{font-size:11px;color:var(--green);text-decoration:underline;cursor:pointer}
    /* Aprovar gasto */
    .aprovar-bar{display:flex;gap:6px;padding:8px 14px;background:#fffbf5;border-top:1px solid var(--border)}
    /* Botão add flutuante */
    .fab{position:fixed;bottom:20px;right:20px;width:54px;height:54px;border-radius:50%;background:var(--green);color:#fff;border:none;font-size:26px;cursor:pointer;box-shadow:0 4px 16px rgba(22,163,74,.4);z-index:50;display:flex;align-items:center;justify-content:center}
    .fab:active{transform:scale(.95)}
    /* Empty */
    .empty{text-align:center;padding:40px 20px;color:var(--gray)}
    .empty-icon{font-size:40px;margin-bottom:12px}
    /* Modais */
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:flex-end;justify-content:center}
    .overlay.show{display:flex}
    .sheet{background:var(--white);border-radius:20px 20px 0 0;padding:20px 18px 36px;width:100%;max-width:520px;animation:su .2s ease;max-height:90vh;overflow-y:auto}
    @keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}
    .sheet-handle{width:36px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 16px}
    .sheet-title{font-size:17px;font-weight:700;margin-bottom:16px}
    .field{margin-bottom:14px}
    .field label{display:block;font-size:13px;font-weight:500;color:var(--gray);margin-bottom:6px}
    .field input,.field select,.field textarea{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;outline:none;background:var(--bg);color:#111}
    .field input:focus,.field select:focus{border-color:var(--green)}
    .field textarea{resize:none;height:70px}
    .checkbox-list{display:flex;flex-direction:column;gap:8px}
    .check-item{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;cursor:pointer;font-size:14px}
    .check-item input{width:16px;height:16px;accent-color:var(--green)}
    .upload-box{border:2px dashed var(--border);border-radius:10px;padding:18px;text-align:center;cursor:pointer;font-size:13px;color:var(--gray)}
    .upload-box:hover{border-color:var(--green)}
    .upload-box input{display:none}
    .preview-img{width:100%;border-radius:8px;margin-top:10px;display:none}
    .sheet-btns{display:flex;gap:8px;margin-top:16px}
    .sheet-btns button{flex:1;padding:13px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer}
    .btn-cancel{background:var(--border);color:#333}
    .btn-confirm{background:var(--green);color:#fff}
    .btn-confirm:disabled{opacity:.6}
    /* Toast */
    .toast{position:fixed;bottom:86px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:300;display:none;white-space:nowrap}
    .toast.show{display:block}
    /* Loading */
    .loading{text-align:center;padding:60px 20px;color:var(--gray);font-size:14px}
  </style>
</head>
<body>

<div id="header-area">
  <div class="header" id="hdr">
    <div class="header-top"><span class="logo">Splitry</span><span class="codigo-pill">${codigo}</span></div>
    <h1 id="hdr-nome">Carregando...</h1>
    <div class="header-sub" id="hdr-sub"></div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Total gasto</div><div class="stat-value g" id="s-total">R$0</div></div>
    <div class="stat"><div class="stat-label">Pendente</div><div class="stat-value r" id="s-pend">R$0</div></div>
  </div>
</div>

<div class="tabs">
  <button class="tab active" onclick="setTab('saldo',this)">Saldo</button>
  <button class="tab" onclick="setTab('gastos',this)">Gastos</button>
  <button class="tab" onclick="setTab('membros',this)">Membros</button>
</div>

<div class="container">
  <div class="who-bar">
    <span class="who-label">Você é:</span>
    <select id="sel-eu" onchange="salvarEu()">
      <option value="">— selecione —</option>
    </select>
  </div>

  <div id="tab-saldo"></div>
  <div id="tab-gastos" style="display:none"></div>
  <div id="tab-membros" style="display:none"></div>
</div>

<button class="fab" id="fab-btn" onclick="abrirModalGasto()" title="Adicionar gasto">+</button>

<!-- Modal: Novo gasto -->
<div class="overlay" id="modal-gasto" onclick="fecharSeOverlay(event,'modal-gasto')">
  <div class="sheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">Novo gasto</div>
    <div class="field"><label>Descrição</label><input id="g-desc" placeholder="Ex: Jantar, Uber, Mercado..." /></div>
    <div class="field"><label>Valor total (R$)</label><input id="g-valor" type="number" step="0.01" placeholder="0,00" /></div>
    <div class="field">
      <label>Excluir da divisão (opcional)</label>
      <div class="checkbox-list" id="g-excluir"></div>
    </div>
    <div id="g-preview" style="font-size:13px;color:var(--gray);margin-bottom:12px"></div>
    <div class="sheet-btns">
      <button class="btn-cancel" onclick="fecharModal('modal-gasto')">Cancelar</button>
      <button class="btn-confirm" onclick="enviarGasto()">Adicionar</button>
    </div>
  </div>
</div>

<!-- Modal: Confirmar pagamento -->
<div class="overlay" id="modal-pagar" onclick="fecharSeOverlay(event,'modal-pagar')">
  <div class="sheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title" id="mp-title">Confirmar pagamento</div>
    <div style="font-size:14px;color:var(--gray);margin-bottom:6px" id="mp-sub"></div>
    <div style="font-size:28px;font-weight:700;color:var(--green);margin-bottom:16px" id="mp-val"></div>
    <div class="upload-box" onclick="document.getElementById('mp-file').click()">
      <input type="file" id="mp-file" accept="image/*" onchange="prevComp(this)">
      <div>📎 Anexar comprovante <small>(opcional)</small></div>
      <img class="preview-img" id="mp-prev">
    </div>
    <div class="sheet-btns" style="margin-top:14px">
      <button class="btn-cancel" onclick="fecharModal('modal-pagar')">Cancelar</button>
      <button class="btn-confirm" id="mp-btn" onclick="enviarPagamento()">Confirmar</button>
    </div>
  </div>
</div>

<!-- Modal: Visualizar comprovante -->
<div class="overlay" id="modal-comp" onclick="fecharSeOverlay(event,'modal-comp')">
  <div class="sheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">Comprovante</div>
    <img id="comp-img" style="width:100%;border-radius:10px;margin-bottom:16px">
    <button class="btn-confirm" style="width:100%;padding:13px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer;background:var(--green);color:#fff" onclick="fecharModal('modal-comp')">Fechar</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const CODIGO = '${codigo}';
let dados = null;
let euTelefone = localStorage.getItem('eu_tel_' + CODIGO) || '';
let euNome = localStorage.getItem('eu_nome_' + CODIGO) || '';
let tabAtiva = 'saldo';
let pendingPag = {};

function fmt(v){ return 'R$' + parseFloat(v||0).toFixed(2); }
function ic(d){
  const s = (d||'').toLowerCase();
  if(s.includes('uber')||s.includes('taxi')||s.includes('99')) return '🚗';
  if(s.includes('jantar')||s.includes('almoç')||s.includes('comida')||s.includes('restaur')||s.includes('pizza')) return '🍽️';
  if(s.includes('mercado')||s.includes('superm')) return '🛒';
  if(s.includes('bar')||s.includes('cerveja')||s.includes('drink')) return '🍺';
  if(s.includes('hotel')||s.includes('hosped')||s.includes('airbnb')||s.includes('pousada')) return '🏨';
  if(s.includes('ingresso')||s.includes('show')||s.includes('cinema')||s.includes('festa')) return '🎟️';
  if(s.includes('gasolina')||s.includes('combus')) return '⛽';
  return '💳';
}

async function carregar() {
  try {
    const r = await fetch('/api/r/' + CODIGO);
    if (!r.ok) { document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#666"><h2>Rateio não encontrado</h2></div>'; return; }
    dados = await r.json();
    renderTudo();
  } catch(e) { console.error(e); }
}

function renderTudo() {
  const { grupo, membros, gastos, saldo } = dados;

  // Header
  document.getElementById('hdr-nome').textContent = grupo.nome;
  document.getElementById('hdr-sub').textContent = membros.length + ' pessoas · ' + gastos.filter(g=>g.status==='aprovado').length + ' gastos aprovados';

  // Stats
  const totalAprov = gastos.filter(g=>g.status==='aprovado').reduce((s,g)=>s+parseFloat(g.valor_total),0);
  const totalPend = saldo.reduce((s,d)=>s+parseFloat(d.total),0);
  document.getElementById('s-total').textContent = fmt(totalAprov);
  document.getElementById('s-pend').textContent = fmt(totalPend);

  // Select "quem sou"
  const sel = document.getElementById('sel-eu');
  const valAtual = sel.value || euTelefone;
  sel.innerHTML = '<option value="">— selecione —</option>' + membros.map(m=>`<option value="${m.telefone}" data-nome="${m.nome}" ${m.telefone===valAtual?'selected':''}>${m.nome}</option>`).join('');
  if (valAtual) { euTelefone = valAtual; euNome = sel.options[sel.selectedIndex]?.dataset.nome || ''; }

  renderTab();
}

function renderTab() {
  if (tabAtiva === 'saldo') renderSaldo();
  else if (tabAtiva === 'gastos') renderGastos();
  else renderMembros();
}

function renderSaldo() {
  const { saldo, gastos } = dados;
  const el = document.getElementById('tab-saldo');

  // Gastos pendentes de aprovação (só criador vê os botões)
  const pendAprov = gastos.filter(g=>g.status==='pendente');
  let htmlPend = '';
  if (pendAprov.length > 0 && euTelefone === dados.grupo.criado_por) {
    htmlPend = '<div style="font-size:12px;font-weight:600;color:var(--amber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">⏳ Aguardando aprovação</div>';
    htmlPend += pendAprov.map(g=>`
      <div class="gasto-card" style="border:1.5px solid var(--amber-l)">
        <div class="gasto-head">
          <div class="gasto-icon">${ic(g.descricao)}</div>
          <div class="gasto-meta"><span class="gasto-desc">${g.descricao}</span><span class="gasto-by">proposto por ${g.proposto_por_nome}</span></div>
          <div class="gasto-total">${fmt(g.valor_total)}</div>
        </div>
        <div class="aprovar-bar">
          <button class="btn-sm btn-green" onclick="aprovar(${g.id})">✓ Aprovar</button>
          <button class="btn-sm btn-red" onclick="rejeitar(${g.id})">✗ Rejeitar</button>
        </div>
      </div>`).join('');
  }

  // Pagamentos aguardando validação (só criador)
  let htmlPagAguard = '';
  if (euTelefone === dados.grupo.criado_por) {
    const aguardando = [];
    gastos.filter(g=>g.status==='aprovado').forEach(g=>{
      (g.participantes||[]).filter(p=>p.status_pagamento==='aguardando_validacao').forEach(p=>{
        aguardando.push({gasto:g, part:p});
      });
    });
    if (aguardando.length > 0) {
      htmlPagAguard = '<div style="font-size:12px;font-weight:600;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 8px">💰 Pagamentos para validar</div>';
      htmlPagAguard += aguardando.map(({gasto,part})=>`
        <div class="saldo-card" style="border:1.5px solid var(--green-l)">
          <div class="av a">${part.nome[0]}</div>
          <div class="saldo-info"><span class="saldo-nome">${part.nome}</span><span class="saldo-sub">${gasto.descricao}</span></div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
            <span style="font-weight:700;color:var(--green)">${fmt(part.valor)}</span>
            ${part.comprovante_url?`<span class="ver-comp" onclick="verComp('${part.comprovante_url}')">ver comprovante</span>`:'<span style="font-size:11px;color:var(--gray)">sem comprovante</span>'}
            <div style="display:flex;gap:4px">
              <button class="btn-sm btn-green" onclick="validarPag(${gasto.id},'${part.telefone}','${part.nome}')">✓</button>
              <button class="btn-sm btn-red" onclick="rejeitarPag(${gasto.id},'${part.telefone}')">✗</button>
            </div>
          </div>
        </div>`).join('');
    }
  }

  // Saldo geral
  let htmlSaldo = '';
  if (saldo.length === 0) {
    htmlSaldo = '<div class="empty"><div class="empty-icon">✅</div><p>Tudo zerado! Ninguém deve nada.</p></div>';
  } else {
    htmlSaldo = '<div style="font-size:12px;font-weight:600;color:var(--gray);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 8px">Saldo atual</div>';
    htmlSaldo += saldo.map(s=>`
      <div class="saldo-card">
        <div class="av r">${s.devedor_nome[0]}</div>
        <div class="saldo-info"><span class="saldo-nome">${s.devedor_nome}</span><span class="saldo-sub">deve para ${s.credor_nome}</span></div>
        <span class="saldo-val">${fmt(s.total)}</span>
      </div>`).join('');
  }

  el.innerHTML = htmlPend + htmlPagAguard + htmlSaldo;
}

function renderGastos() {
  const { gastos } = dados;
  const el = document.getElementById('tab-gastos');
  if (gastos.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">💸</div><p>Nenhum gasto ainda.<br>Toque + para adicionar.</p></div>';
    return;
  }

  el.innerHTML = gastos.map(g=>{
    const parts = g.participantes || [];
    const aprovados = parts.filter(p=>p.status_pagamento==='pago').length;
    const total = parts.filter(p=>p.telefone !== g.proposto_por_telefone).length;
    const prog = total > 0 ? Math.round(aprovados/total*100) : 100;

    const linhasParts = parts.filter(p=>p.telefone!==g.proposto_por_telefone).map(p=>{
      const souEu = p.telefone === euTelefone;
      let acoes = '';
      if (p.status_pagamento === 'pendente' && souEu) {
        acoes = `<button class="btn-sm btn-green" onclick="abrirModalPagar(${g.id},'${p.telefone}','${p.nome}',${p.valor})">Paguei</button>`;
      } else if (p.status_pagamento === 'aguardando_validacao') {
        acoes = `<span class="badge aguard">⏳ Em análise</span>${p.comprovante_url?`<span class="ver-comp" onclick="verComp('${p.comprovante_url}')">comprovante</span>`:''}`;
      } else if (p.status_pagamento === 'pago') {
        acoes = `<span class="badge pago">✓ Pago</span>${p.comprovante_url?`<span class="ver-comp" onclick="verComp('${p.comprovante_url}')">comprovante</span>`:''}`;
      } else if (p.status_pagamento === 'pendente') {
        acoes = `<span class="badge pend">Pendente</span>`;
      }
      return `
        <div class="part-row">
          <div class="part-av">${p.nome[0]}</div>
          <div class="part-info"><span class="part-nome">${p.nome}${souEu?' (você)':''}</span><span class="part-val">${fmt(p.valor)}</span></div>
          <div class="part-actions">${acoes}</div>
        </div>`;
    }).join('');

    const statusPill = g.status === 'aprovado'
      ? `<span class="status-pill sp-aprovado">✓ aprovado</span>`
      : g.status === 'pendente'
        ? `<span class="status-pill sp-pendente">⏳ aguardando</span>`
        : `<span class="status-pill sp-rejeitado">✗ rejeitado</span>`;

    return `
      <div class="gasto-card">
        <div class="gasto-head">
          <div class="gasto-icon">${ic(g.descricao)}</div>
          <div class="gasto-meta">
            <span class="gasto-desc">${g.descricao}${statusPill}</span>
            <span class="gasto-by">Pago por ${g.proposto_por_nome}</span>
          </div>
          <div class="gasto-total">${fmt(g.valor_total)}</div>
        </div>
        ${g.status==='aprovado'?`
          <div class="prog-bar"><div class="prog-fill" style="width:${prog}%"></div></div>
          <div class="prog-lbl">${aprovados} de ${total} confirmados</div>
        `:''}
        <div class="parts-list">${linhasParts}</div>
        ${g.status==='pendente' && euTelefone===dados.grupo.criado_por?`
          <div class="aprovar-bar">
            <button class="btn-sm btn-green" onclick="aprovar(${g.id})">✓ Aprovar</button>
            <button class="btn-sm btn-red" onclick="rejeitar(${g.id})">✗ Rejeitar</button>
          </div>`:''}
      </div>`;
  }).join('');
}

function renderMembros() {
  const { membros, grupo } = dados;
  const el = document.getElementById('tab-membros');
  el.innerHTML = `
    <div style="font-size:13px;color:var(--gray);margin-bottom:12px">
      Para convidar alguém, compartilhe este link:<br>
      <span style="font-weight:600;color:var(--green);word-break:break-all">${window.location.href}</span>
    </div>
    ${membros.map(m=>`
      <div class="saldo-card">
        <div class="av g">${m.nome[0]}</div>
        <div class="saldo-info">
          <span class="saldo-nome">${m.nome}${m.telefone===grupo.criado_por?' 👑':''}</span>
          <span class="saldo-sub">${m.telefone===grupo.criado_por?'organizador':'membro'}</span>
        </div>
      </div>`).join('')}`;
}

// Tabs
function setTab(tab, btn) {
  tabAtiva = tab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  ['saldo','gastos','membros'].forEach(t=>{
    document.getElementById('tab-'+t).style.display = t===tab?'block':'none';
  });
  renderTab();
}

function salvarEu() {
  const sel = document.getElementById('sel-eu');
  euTelefone = sel.value;
  euNome = sel.options[sel.selectedIndex]?.dataset.nome || '';
  localStorage.setItem('eu_tel_'+CODIGO, euTelefone);
  localStorage.setItem('eu_nome_'+CODIGO, euNome);
  renderTab();
}

// Gasto
function abrirModalGasto() {
  if (!euTelefone) { toast('Selecione quem você é primeiro'); return; }
  const membros = dados.membros;
  document.getElementById('g-desc').value = '';
  document.getElementById('g-valor').value = '';
  document.getElementById('g-excluir').innerHTML = membros
    .filter(m=>m.telefone!==euTelefone)
    .map(m=>`<label class="check-item"><input type="checkbox" value="${m.telefone}"> ${m.nome}</label>`).join('');
  document.getElementById('g-preview').textContent = '';

  document.getElementById('g-valor').oninput = atualizarPreview;
  document.querySelectorAll('#g-excluir input').forEach(c=>c.onchange=atualizarPreview);

  document.getElementById('modal-gasto').classList.add('show');
  document.getElementById('g-desc').focus();
}

function atualizarPreview() {
  const val = parseFloat(document.getElementById('g-valor').value) || 0;
  const excl = [...document.querySelectorAll('#g-excluir input:checked')].map(c=>c.value);
  const total = dados.membros.length - excl.length;
  if (val > 0 && total > 0) {
    document.getElementById('g-preview').textContent = 'Cada um paga: ' + fmt(val/total) + ' (' + total + ' pessoas)';
  }
}

async function enviarGasto() {
  const desc = document.getElementById('g-desc').value.trim();
  const valor = parseFloat(document.getElementById('g-valor').value);
  if (!desc || !valor) { toast('Preencha descrição e valor'); return; }

  const excl = [...document.querySelectorAll('#g-excluir input:checked')].map(c=>c.value);
  const body = new FormData();
  body.append('descricao', desc);
  body.append('valor', valor);
  body.append('proposto_por_telefone', euTelefone);
  body.append('proposto_por_nome', euNome);
  body.append('participantes_excluidos', JSON.stringify(excl));

  try {
    const r = await fetch('/api/r/'+CODIGO+'/gasto', {method:'POST', body});
    const d = await r.json();
    fecharModal('modal-gasto');
    await carregar();
    toast(d.status==='aprovado' ? 'Gasto adicionado!' : 'Gasto enviado para aprovação');
    setTab('gastos', document.querySelectorAll('.tab')[1]);
  } catch(e) { toast('Erro ao adicionar gasto'); }
}

// Aprovar/rejeitar gasto
async function aprovar(gastoId) {
  if (!euTelefone) { toast('Selecione quem você é'); return; }
  await fetch('/api/r/'+CODIGO+'/gasto/'+gastoId+'/aprovar', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:euTelefone})});
  await carregar(); toast('Gasto aprovado!');
}

async function rejeitar(gastoId) {
  if (!euTelefone) { toast('Selecione quem você é'); return; }
  await fetch('/api/r/'+CODIGO+'/gasto/'+gastoId+'/rejeitar', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:euTelefone})});
  await carregar(); toast('Gasto rejeitado');
}

// Pagamento
function abrirModalPagar(gastoId, tel, nome, valor) {
  pendingPag = {gastoId, tel, nome, valor};
  document.getElementById('mp-title').textContent = 'Confirmar pagamento';
  document.getElementById('mp-sub').textContent = nome + ', confirme seu pagamento:';
  document.getElementById('mp-val').textContent = fmt(valor);
  document.getElementById('mp-prev').style.display = 'none';
  document.getElementById('mp-file').value = '';
  document.getElementById('modal-pagar').classList.add('show');
}

function prevComp(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { const img = document.getElementById('mp-prev'); img.src = e.target.result; img.style.display = 'block'; };
  reader.readAsDataURL(file);
}

async function enviarPagamento() {
  const btn = document.getElementById('mp-btn');
  btn.disabled = true; btn.textContent = 'Enviando...';
  const fd = new FormData();
  fd.append('telefone', pendingPag.tel);
  fd.append('nome', pendingPag.nome);
  const file = document.getElementById('mp-file').files[0];
  if (file) fd.append('comprovante', file);

  try {
    await fetch('/api/r/'+CODIGO+'/gasto/'+pendingPag.gastoId+'/confirmar', {method:'POST',body:fd});
    fecharModal('modal-pagar');
    await carregar();
    toast('Pagamento enviado para validação!');
  } catch(e) { toast('Erro ao confirmar'); }
  btn.disabled = false; btn.textContent = 'Confirmar';
}

// Validar/rejeitar pagamento (criador)
async function validarPag(gastoId, devedorTel, devedorNome) {
  await fetch('/api/r/'+CODIGO+'/gasto/'+gastoId+'/validar', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone_criador:euTelefone,telefone_devedor:devedorTel,nome_devedor:devedorNome})});
  await carregar(); toast('Pagamento validado!');
}

async function rejeitarPag(gastoId, devedorTel) {
  await fetch('/api/r/'+CODIGO+'/gasto/'+gastoId+'/rejeitar-pagamento', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone_criador:euTelefone,telefone_devedor:devedorTel})});
  await carregar(); toast('Comprovante rejeitado — devedor será notificado');
}

// Comprovante
function verComp(url) {
  document.getElementById('comp-img').src = url;
  document.getElementById('modal-comp').classList.add('show');
}

// Utils
function fecharModal(id) { document.getElementById(id).classList.remove('show'); }
function fecharSeOverlay(e,id) { if(e.target.id===id) fecharModal(id); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 3000);
}

// Atualiza a cada 20s
carregar();
setInterval(carregar, 20000);
</script>
</body>
</html>`;
}

db.init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}).catch(err => { console.error('Erro banco:', err); process.exit(1); });
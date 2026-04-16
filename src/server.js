require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { handleMetaMessage } = require('./bot');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Upload de comprovantes
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
app.use('/uploads', express.static(uploadDir));

// ─── Webhook Meta ─────────────────────────────────────────────
app.get('/webhook/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verificado!');
    res.status(200).send(challenge);
  } else res.sendStatus(403);
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
        for (const message of value.messages) {
          if (message.type !== 'text') continue;
          const from = message.from;
          const text = message.text.body;
          const nomeRemetente = (value.contacts || []).find(c => c.wa_id === from)?.profile?.name || null;
          console.log(`[${new Date().toISOString()}] ${from} (${nomeRemetente}): ${text}`);
          await handleMetaMessage(from, text, nomeRemetente);
        }
      }
    }
  } catch (err) { console.error('Erro webhook:', err); }
});

// ─── Página do rateio ─────────────────────────────────────────
app.get('/r/:codigo', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).send(paginaErro('Rateio não encontrado'));

    const [membros, gastos, saldo] = await Promise.all([
      db.getMembros(grupo.id),
      db.getGastosDoMes(grupo.id),
      db.getSaldoGrupo(grupo.id)
    ]);

    const gastosComParcelas = await Promise.all(gastos.map(async g => ({
      ...g,
      parcelas: await db.getParcelas(g.id)
    })));

    const totalGasto = gastos.reduce((s, g) => s + parseFloat(g.valor_total), 0);
    const totalPendente = saldo.reduce((s, d) => s + parseFloat(d.total), 0);

    res.send(paginaRateio(grupo, membros, gastosComParcelas, saldo, totalGasto, totalPendente));
  } catch (err) {
    console.error('Erro página:', err);
    res.status(500).send(paginaErro('Erro interno'));
  }
});

// ─── API: confirmar pagamento ─────────────────────────────────
app.post('/r/:codigo/pagar', upload.single('comprovante'), async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Grupo não encontrado' });

    const { gasto_id, telefone, nome } = req.body;
    const comprovanteUrl = req.file ? `/uploads/${req.file.filename}` : null;

    await db.confirmarPagamento(gasto_id, telefone, comprovanteUrl);

    // Notifica credor via WhatsApp
    const { enviarMensagem } = require('./meta');
    const gasto = await db.getGasto(gasto_id);
    const parcelas = await db.getParcelas(gasto_id);
    const parcela = parcelas.find(p => p.devedor_telefone === telefone);
    if (gasto && parcela) {
      const baseUrl = process.env.BASE_URL || `https://splitry-bot-production.up.railway.app`;
      const link = `${baseUrl}/r/${grupo.codigo}`;
      await enviarMensagem(gasto.pago_por_telefone,
        `✅ *${nome || parcela.devedor_nome}* confirmou pagamento de R$${parseFloat(parcela.valor).toFixed(2)} de "${gasto.descricao}"\n\nVeja o comprovante:\n${link}`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro confirmar:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── API: dados do rateio (para polling) ─────────────────────
app.get('/r/:codigo/dados', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Not found' });
    const [gastos, saldo] = await Promise.all([
      db.getGastosDoMes(grupo.id),
      db.getSaldoGrupo(grupo.id)
    ]);
    const gastosComParcelas = await Promise.all(gastos.map(async g => ({
      ...g, parcelas: await db.getParcelas(g.id)
    })));
    res.json({ gastos: gastosComParcelas, saldo });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/', (_req, res) => res.send('Splitry rodando!'));

// ─── HTML da página ───────────────────────────────────────────
function paginaErro(msg) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Splitry</title>
  <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4}
  .card{text-align:center;padding:32px;background:white;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h2{color:#16a34a;margin-bottom:8px}p{color:#666}</style></head>
  <body><div class="card"><h2>Splitry</h2><p>${msg}</p></div></body></html>`;
}

function paginaRateio(grupo, membros, gastos, saldo, totalGasto, totalPendente) {
  const codigo = grupo.codigo;

  const cardsSaldo = saldo.length === 0
    ? `<div class="empty-state"><div class="check-icon">✓</div><p>Tudo zerado! Ninguém deve nada.</p></div>`
    : saldo.map(s => `
      <div class="saldo-card">
        <div class="saldo-avatars">
          <div class="avatar red">${s.devedor_nome[0]}</div>
          <div class="seta-icon">→</div>
          <div class="avatar green">${s.pago_por_nome[0]}</div>
        </div>
        <div class="saldo-info">
          <span class="saldo-nome">${s.devedor_nome}</span>
          <span class="saldo-desc">deve para ${s.pago_por_nome}</span>
        </div>
        <div class="saldo-valor">R$${parseFloat(s.total).toFixed(2)}</div>
      </div>`).join('');

  const cardsGastos = gastos.length === 0
    ? `<div class="empty-state"><p>Nenhum gasto registrado ainda.</p></div>`
    : gastos.map(g => {
      const totalParcelas = g.parcelas.length;
      const pagas = g.parcelas.filter(p => p.pago).length;
      const progresso = totalParcelas > 0 ? Math.round((pagas / totalParcelas) * 100) : 0;

      const linhasParcelas = g.parcelas.map(p => `
        <div class="parcela-row ${p.pago ? 'pago' : 'pendente'}">
          <div class="parcela-avatar">${p.devedor_nome[0]}</div>
          <div class="parcela-info">
            <span class="parcela-nome">${p.devedor_nome}</span>
            <span class="parcela-valor">R$${parseFloat(p.valor).toFixed(2)}</span>
          </div>
          <div class="parcela-status">
            ${p.pago
              ? `<span class="badge pago">✓ Pago</span>${p.comprovante_url ? `<a href="${p.comprovante_url}" target="_blank" class="ver-comprovante">ver comprovante</a>` : ''}`
              : `<button class="btn-pagar" onclick="abrirModal('${g.id}','${p.devedor_telefone}','${p.devedor_nome}',${parseFloat(p.valor).toFixed(2)})">Já paguei</button>`
            }
          </div>
        </div>`).join('');

      return `
        <div class="gasto-card">
          <div class="gasto-header">
            <div class="gasto-icon">${iconCategoria(g.descricao)}</div>
            <div class="gasto-info">
              <span class="gasto-desc">${g.descricao}</span>
              <span class="gasto-meta">Pago por ${g.pago_por_nome}</span>
            </div>
            <div class="gasto-valor-total">R$${parseFloat(g.valor_total).toFixed(2)}</div>
          </div>
          <div class="progresso-bar"><div class="progresso-fill" style="width:${progresso}%"></div></div>
          <div class="progresso-label">${pagas} de ${totalParcelas} confirmados</div>
          <div class="parcelas-list">${linhasParcelas}</div>
        </div>`;
    }).join('');

  const tagsMembros = membros.map(m =>
    `<div class="membro-tag"><div class="avatar-sm">${m.nome[0]}</div>${m.nome}</div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${grupo.nome} — Splitry</title>
  <style>
    :root{--green:#16a34a;--green-light:#dcfce7;--green-mid:#22c55e;--red:#dc2626;--red-light:#fee2e2;--gray:#6b7280;--bg:#f0fdf4;--white:#ffffff;--border:#e5e7eb;--shadow:0 2px 12px rgba(0,0,0,.06)}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:#111;min-height:100vh}
    .header{background:linear-gradient(135deg,#15803d,#16a34a);color:white;padding:24px 20px 32px;position:relative;overflow:hidden}
    .header::after{content:'';position:absolute;right:-40px;top:-40px;width:180px;height:180px;background:rgba(255,255,255,.08);border-radius:50%}
    .header-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
    .logo{font-size:13px;font-weight:600;opacity:.8;letter-spacing:1px;text-transform:uppercase}
    .codigo-badge{background:rgba(255,255,255,.2);padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:1px}
    .header h1{font-size:24px;font-weight:700;margin-bottom:2px}
    .header-sub{font-size:13px;opacity:.8}
    .stats-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 16px;margin-top:-20px;position:relative;z-index:1}
    .stat-card{background:white;border-radius:16px;padding:16px;box-shadow:var(--shadow)}
    .stat-label{font-size:12px;color:var(--gray);margin-bottom:4px}
    .stat-value{font-size:24px;font-weight:700}
    .stat-value.green{color:var(--green)}
    .stat-value.red{color:var(--red)}
    .container{padding:16px;max-width:520px;margin:0 auto}
    .section-header{display:flex;align-items:center;gap:8px;margin:20px 0 10px}
    .section-title{font-size:13px;font-weight:600;color:var(--gray);text-transform:uppercase;letter-spacing:.5px}
    .empty-state{text-align:center;padding:24px;color:var(--gray);font-size:14px}
    .check-icon{font-size:32px;margin-bottom:8px;color:var(--green)}
    .saldo-card{background:white;border-radius:14px;padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow)}
    .saldo-avatars{display:flex;align-items:center;gap:4px}
    .avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:white;flex-shrink:0}
    .avatar.red{background:var(--red)}
    .avatar.green{background:var(--green)}
    .seta-icon{color:var(--gray);font-size:14px}
    .saldo-info{flex:1;min-width:0}
    .saldo-nome{font-weight:600;font-size:14px;display:block}
    .saldo-desc{font-size:12px;color:var(--gray)}
    .saldo-valor{font-weight:700;color:var(--red);font-size:15px;white-space:nowrap}
    .gasto-card{background:white;border-radius:16px;margin-bottom:12px;overflow:hidden;box-shadow:var(--shadow)}
    .gasto-header{display:flex;align-items:center;gap:12px;padding:16px}
    .gasto-icon{font-size:24px;width:44px;height:44px;background:var(--green-light);border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .gasto-info{flex:1;min-width:0}
    .gasto-desc{font-weight:600;font-size:15px;display:block}
    .gasto-meta{font-size:12px;color:var(--gray)}
    .gasto-valor-total{font-weight:700;font-size:16px;color:#111;white-space:nowrap}
    .progresso-bar{height:4px;background:#e5e7eb;margin:0 16px}
    .progresso-fill{height:100%;background:var(--green-mid);border-radius:2px;transition:width .3s}
    .progresso-label{font-size:11px;color:var(--gray);padding:4px 16px 8px;text-align:right}
    .parcelas-list{border-top:1px solid var(--border)}
    .parcela-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
    .parcela-row:last-child{border-bottom:none}
    .parcela-row.pago{background:#fafffe}
    .parcela-row.pendente{background:#fffbf5}
    .parcela-avatar{width:32px;height:32px;border-radius:50%;background:var(--green-light);color:var(--green);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
    .parcela-info{flex:1;min-width:0}
    .parcela-nome{font-weight:500;font-size:14px;display:block}
    .parcela-valor{font-size:13px;color:var(--gray)}
    .parcela-status{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
    .badge{font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px}
    .badge.pago{background:var(--green-light);color:var(--green)}
    .ver-comprovante{font-size:11px;color:var(--green);text-decoration:underline}
    .btn-pagar{background:var(--green);color:white;border:none;border-radius:20px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
    .btn-pagar:active{opacity:.85}
    .membros-row{display:flex;flex-wrap:wrap;gap:8px}
    .membro-tag{display:flex;align-items:center;gap:6px;background:white;border-radius:20px;padding:6px 12px;font-size:13px;box-shadow:var(--shadow)}
    .avatar-sm{width:24px;height:24px;border-radius:50%;background:var(--green-light);color:var(--green);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px}
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:flex-end;justify-content:center}
    .modal-overlay.show{display:flex}
    .modal-sheet{background:white;border-radius:24px 24px 0 0;padding:24px 20px 40px;width:100%;max-width:520px;animation:slideUp .25s ease}
    @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
    .modal-handle{width:40px;height:4px;background:#e5e7eb;border-radius:2px;margin:0 auto 20px}
    .modal-title{font-size:18px;font-weight:700;margin-bottom:4px}
    .modal-sub{font-size:14px;color:var(--gray);margin-bottom:20px}
    .modal-valor{font-size:28px;font-weight:700;color:var(--green);margin-bottom:20px}
    .upload-area{border:2px dashed var(--border);border-radius:12px;padding:20px;text-align:center;margin-bottom:16px;cursor:pointer;transition:border-color .2s}
    .upload-area:hover{border-color:var(--green)}
    .upload-area input{display:none}
    .upload-icon{font-size:28px;margin-bottom:8px}
    .upload-text{font-size:14px;color:var(--gray)}
    .upload-preview{max-width:100%;border-radius:8px;margin-top:12px;display:none}
    .modal-btns{display:flex;gap:10px}
    .btn-cancelar{flex:1;padding:14px;border-radius:14px;border:1px solid var(--border);background:white;font-size:15px;font-weight:500;cursor:pointer;color:#333}
    .btn-confirmar{flex:2;padding:14px;border-radius:14px;border:none;background:var(--green);color:white;font-size:15px;font-weight:600;cursor:pointer}
    .btn-confirmar:disabled{opacity:.6}
    .toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#111;color:white;padding:12px 20px;border-radius:12px;font-size:14px;display:none;z-index:200;white-space:nowrap}
    .toast.show{display:block}
    .refresh-btn{background:none;border:none;color:var(--gray);font-size:13px;cursor:pointer;padding:4px 8px;border-radius:8px}
    .refresh-btn:hover{background:var(--border)}
  </style>
</head>
<body>
  <div class="header">
    <div class="header-top">
      <span class="logo">Splitry</span>
      <span class="codigo-badge">${codigo}</span>
    </div>
    <h1>${grupo.nome}</h1>
    <div class="header-sub">${membros.length} pessoas · ${gastos.length} gasto${gastos.length !== 1 ? 's' : ''}</div>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Total gasto</div>
      <div class="stat-value green">R$${totalGasto.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Pendente</div>
      <div class="stat-value red">R$${totalPendente.toFixed(2)}</div>
    </div>
  </div>

  <div class="container">
    <div class="section-header">
      <span class="section-title">Saldo</span>
      <button class="refresh-btn" onclick="location.reload()">↻ atualizar</button>
    </div>
    ${cardsSaldo}

    <div class="section-header">
      <span class="section-title">Gastos</span>
    </div>
    ${cardsGastos}

    <div class="section-header">
      <span class="section-title">Membros</span>
    </div>
    <div class="membros-row">${tagsMembros}</div>
  </div>

  <!-- Modal confirmação -->
  <div class="modal-overlay" id="modal" onclick="fecharModal(event)">
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-title">Confirmar pagamento</div>
      <div class="modal-sub" id="modal-sub"></div>
      <div class="modal-valor" id="modal-valor"></div>

      <div class="upload-area" onclick="document.getElementById('file-input').click()">
        <input type="file" id="file-input" accept="image/*" onchange="previewFile(this)">
        <div class="upload-icon">📎</div>
        <div class="upload-text">Anexar comprovante (opcional)<br><small>Toque para selecionar imagem</small></div>
        <img class="upload-preview" id="preview-img">
      </div>

      <div class="modal-btns">
        <button class="btn-cancelar" onclick="fecharModal()">Cancelar</button>
        <button class="btn-confirmar" id="btn-confirmar" onclick="executarPagamento()">Confirmar pagamento</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let pendingData = {};

    function abrirModal(gastoId, telefone, nome, valor) {
      pendingData = { gastoId, telefone, nome, valor };
      document.getElementById('modal-sub').textContent = nome + ' confirma o pagamento?';
      document.getElementById('modal-valor').textContent = 'R$' + parseFloat(valor).toFixed(2);
      document.getElementById('modal').classList.add('show');
      document.getElementById('preview-img').style.display = 'none';
      document.getElementById('file-input').value = '';
    }

    function fecharModal(e) {
      if (!e || e.target === document.getElementById('modal')) {
        document.getElementById('modal').classList.remove('show');
      }
    }

    function previewFile(input) {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const img = document.getElementById('preview-img');
        img.src = e.target.result;
        img.style.display = 'block';
      };
      reader.readAsDataURL(file);
    }

    async function executarPagamento() {
      const btn = document.getElementById('btn-confirmar');
      btn.disabled = true;
      btn.textContent = 'Confirmando...';

      const formData = new FormData();
      formData.append('gasto_id', pendingData.gastoId);
      formData.append('telefone', pendingData.telefone);
      formData.append('nome', pendingData.nome);
      const fileInput = document.getElementById('file-input');
      if (fileInput.files[0]) formData.append('comprovante', fileInput.files[0]);

      try {
        const res = await fetch('/r/${codigo}/pagar', { method: 'POST', body: formData });
        if (res.ok) {
          fecharModal();
          mostrarToast('Pagamento confirmado! ✓');
          setTimeout(() => location.reload(), 1800);
        } else {
          mostrarToast('Erro ao confirmar. Tente novamente.');
        }
      } catch(e) {
        mostrarToast('Erro de conexão.');
      }

      btn.disabled = false;
      btn.textContent = 'Confirmar pagamento';
    }

    function mostrarToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    // Auto-atualiza a cada 30 segundos
    setInterval(() => location.reload(), 30000);
  </script>
</body>
</html>`;
}

function iconCategoria(desc) {
  const d = desc.toLowerCase();
  if (d.includes('uber') || d.includes('taxi') || d.includes('transport')) return '🚗';
  if (d.includes('jantar') || d.includes('almoço') || d.includes('comida') || d.includes('restaur')) return '🍽️';
  if (d.includes('mercado') || d.includes('supermercado')) return '🛒';
  if (d.includes('bar') || d.includes('bebida') || d.includes('cerveja')) return '🍺';
  if (d.includes('hotel') || d.includes('hospedagem') || d.includes('airbnb')) return '🏨';
  if (d.includes('ingresso') || d.includes('show') || d.includes('cinema')) return '🎟️';
  return '💳';
}

// Inicia banco e servidor
db.init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}).catch(err => {
  console.error('Erro ao iniciar banco:', err);
  process.exit(1);
});
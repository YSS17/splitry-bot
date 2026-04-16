require('dotenv').config();
const express = require('express');
const { handleMetaMessage } = require('./bot');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Webhook Meta: verificação ───────────────────────────────
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook Meta: mensagens ─────────────────────────────────
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
          const contacts = value.contacts || [];
          const nomeRemetente = contacts.find(c => c.wa_id === from)?.profile?.name || null;
          console.log(`[${new Date().toISOString()}] ${from} (${nomeRemetente}): ${text}`);
          await handleMetaMessage(from, text, nomeRemetente);
        }
      }
    }
  } catch (err) {
    console.error('Erro webhook:', err);
  }
});

// ─── Página do rateio ─────────────────────────────────────────
app.get('/r/:codigo', (req, res) => {
  const { codigo } = req.params;
  const grupo = db.verificarCodigo(codigo);
  if (!grupo) return res.status(404).send('Rateio não encontrado.');

  const membros = db.getMembros(grupo.id);
  const gastos = db.getGastosDoMes(grupo.id);
  const saldo = db.getSaldoGrupo(grupo.id);

  // Monta HTML da página
  const totalGasto = gastos.reduce((s, g) => s + g.valor_total, 0);

  const linhasSaldo = saldo.length === 0
    ? '<p style="color:#16a34a;font-weight:500">✓ Tudo zerado! Ninguém deve nada.</p>'
    : saldo.map(s => `
      <div class="card-devida">
        <div class="devida-info">
          <span class="nome">${s.devedor_nome}</span>
          <span class="seta">→</span>
          <span class="nome">${s.pago_por_nome}</span>
          <span class="valor">R$${s.total.toFixed(2)}</span>
        </div>
      </div>
    `).join('');

  const linhasGastos = gastos.map(g => {
    const parcelas = db.getParcelas(g.id);
    const linhasParcelas = parcelas.map(p => `
      <div class="parcela ${p.pago ? 'pago' : 'pendente'}">
        <span>${p.devedor_nome}</span>
        <span>R$${p.valor.toFixed(2)}</span>
        <span class="status-badge">${p.pago ? '✓ Pago' : '⏳ Pendente'}</span>
        ${!p.pago ? `<button class="btn-pago" onclick="confirmarPagamento('${g.id}','${p.devedor_telefone}','${p.devedor_nome}')">Já paguei</button>` : ''}
      </div>
    `).join('');
    return `
      <div class="gasto-card">
        <div class="gasto-header">
          <span class="gasto-desc">${g.descricao}</span>
          <span class="gasto-valor">R$${g.valor_total.toFixed(2)}</span>
          <span class="gasto-pago">Pago por ${g.pago_por_nome}</span>
        </div>
        <div class="parcelas">${linhasParcelas}</div>
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${grupo.nome} — Splitry</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #1a1a1a; }
    .header { background: #25D366; color: white; padding: 20px 16px; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .header p { font-size: 13px; opacity: 0.85; margin-top: 4px; }
    .container { max-width: 480px; margin: 0 auto; padding: 16px; }
    .section-title { font-size: 13px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin: 20px 0 8px; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 4px; }
    .stat-card { background: white; border-radius: 12px; padding: 14px; }
    .stat-label { font-size: 12px; color: #888; }
    .stat-value { font-size: 22px; font-weight: 600; margin-top: 2px; }
    .card-devida { background: white; border-radius: 12px; padding: 14px 16px; margin-bottom: 8px; }
    .devida-info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .nome { font-weight: 500; font-size: 15px; }
    .seta { color: #888; }
    .valor { margin-left: auto; font-weight: 600; color: #e53e3e; }
    .gasto-card { background: white; border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; }
    .gasto-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .gasto-desc { font-weight: 500; font-size: 15px; }
    .gasto-valor { margin-left: auto; font-weight: 600; }
    .gasto-pago { width: 100%; font-size: 12px; color: #888; }
    .parcelas { display: flex; flex-direction: column; gap: 8px; }
    .parcela { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 14px; flex-wrap: wrap; }
    .parcela.pago { background: #f0fdf4; }
    .parcela.pendente { background: #fff7ed; }
    .status-badge { margin-left: auto; font-size: 12px; font-weight: 500; }
    .parcela.pago .status-badge { color: #16a34a; }
    .parcela.pendente .status-badge { color: #d97706; }
    .btn-pago { background: #25D366; color: white; border: none; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; margin-left: auto; }
    .btn-pago:active { opacity: 0.8; }
    .membros { display: flex; gap: 8px; flex-wrap: wrap; }
    .membro-tag { background: white; border-radius: 20px; padding: 6px 12px; font-size: 13px; }
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 100; }
    .modal.show { display: flex; }
    .modal-card { background: white; border-radius: 16px; padding: 24px; width: 300px; text-align: center; }
    .modal-card h3 { font-size: 17px; margin-bottom: 8px; }
    .modal-card p { font-size: 14px; color: #666; margin-bottom: 20px; }
    .modal-btns { display: flex; gap: 10px; }
    .modal-btns button { flex: 1; padding: 10px; border-radius: 10px; border: none; font-size: 14px; cursor: pointer; }
    .btn-cancelar { background: #f0f0f0; color: #333; }
    .btn-confirmar { background: #25D366; color: white; font-weight: 500; }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1a1a1a; color: white; padding: 12px 20px; border-radius: 10px; font-size: 14px; display: none; z-index: 200; }
    .toast.show { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${grupo.nome}</h1>
    <p>Código: ${grupo.codigo} · ${membros.length} pessoas</p>
  </div>

  <div class="container">
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Total gasto</div>
        <div class="stat-value">R$${totalGasto.toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pendente</div>
        <div class="stat-value" style="color:#e53e3e">R$${saldo.reduce((s,d) => s + d.total, 0).toFixed(2)}</div>
      </div>
    </div>

    <div class="section-title">Saldo atual</div>
    ${linhasSaldo}

    <div class="section-title">Gastos</div>
    ${linhasGastos || '<p style="color:#888;font-size:14px">Nenhum gasto registrado ainda.</p>'}

    <div class="section-title">Membros</div>
    <div class="membros">
      ${membros.map(m => `<div class="membro-tag">${m.nome}</div>`).join('')}
    </div>
  </div>

  <div class="modal" id="modal">
    <div class="modal-card">
      <h3>Confirmar pagamento</h3>
      <p id="modal-texto"></p>
      <div class="modal-btns">
        <button class="btn-cancelar" onclick="fecharModal()">Cancelar</button>
        <button class="btn-confirmar" onclick="executarPagamento()">Confirmar</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let pendingGastoId, pendingTelefone, pendingNome;

    function confirmarPagamento(gastoId, telefone, nome) {
      pendingGastoId = gastoId;
      pendingTelefone = telefone;
      pendingNome = nome;
      document.getElementById('modal-texto').textContent = nome + ' confirma que pagou?';
      document.getElementById('modal').classList.add('show');
    }

    function fecharModal() {
      document.getElementById('modal').classList.remove('show');
    }

    async function executarPagamento() {
      fecharModal();
      try {
        const res = await fetch('/r/${codigo}/pagar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gasto_id: pendingGastoId, telefone: pendingTelefone })
        });
        if (res.ok) {
          mostrarToast('Pagamento confirmado!');
          setTimeout(() => location.reload(), 1500);
        } else {
          mostrarToast('Erro ao confirmar. Tente novamente.');
        }
      } catch(e) {
        mostrarToast('Erro de conexão.');
      }
    }

    function mostrarToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// ─── API: confirmar pagamento via página ──────────────────────
app.post('/r/:codigo/pagar', async (req, res) => {
  const { codigo } = req.params;
  const { gasto_id, telefone } = req.body;

  const grupo = db.verificarCodigo(codigo);
  if (!grupo) return res.status(404).json({ error: 'Grupo não encontrado' });

  try {
    db.confirmarPagamento(gasto_id, telefone);

    // Notifica o credor via WhatsApp
    const { enviarMensagem } = require('./meta');
    const gasto = db.getGasto(gasto_id);
    const parcelas = db.getParcelas(gasto_id);
    const parcela = parcelas.find(p => p.devedor_telefone === telefone);
    if (gasto && parcela) {
      const devedorNome = db.getUsuario(telefone)?.nome || 'Alguém';
      await enviarMensagem(gasto.pago_por_telefone,
        `✅ *${devedorNome}* confirmou pagamento de R$${parcela.valor.toFixed(2)} referente a "${gasto.descricao}"`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao confirmar pagamento:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/', (_req, res) => res.send('Splitry Bot rodando!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
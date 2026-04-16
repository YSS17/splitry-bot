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
app.use('/public', express.static(path.join(__dirname, '../public')));

// Webhook Meta
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

// API
app.get('/api/r/:codigo', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Rateio não encontrado' });
    const [membros, gastos, saldo] = await Promise.all([
      db.getMembros(grupo.id),
      db.getGastos(grupo.id),
      db.getSaldoGrupo(grupo.id)
    ]);
    const gastosComParts = await Promise.all(gastos.map(async g => ({
      ...g, participantes: await db.getParticipantes(g.id)
    })));
    res.json({ grupo, membros, gastos: gastosComParts, saldo });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/r/:codigo/gasto', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { descricao, valor, proposto_por_telefone, proposto_por_nome, participantes_excluidos } = req.body;
    const membros = await db.getMembros(grupo.id);
    const ehCriador = grupo.criado_por === proposto_por_telefone;
    const excluidos = Array.isArray(participantes_excluidos) ? participantes_excluidos : (participantes_excluidos ? JSON.parse(participantes_excluidos) : []);
    const incluidos = membros.filter(m => !excluidos.includes(m.telefone));
    const parte = parseFloat(valor) / incluidos.length;
    const participantes = incluidos.map(m => ({ telefone: m.telefone, nome: m.nome, valor: parte }));
    const status = ehCriador ? 'aprovado' : 'pendente';
    const gastoId = await db.criarGasto(grupo.id, descricao, parseFloat(valor), proposto_por_telefone, proposto_por_nome, participantes, status);
    if (!ehCriador) {
      const base = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
      await enviarMensagem(grupo.criado_por,
        `📋 *${proposto_por_nome}* propôs R$${parseFloat(valor).toFixed(2)} em "${descricao}". Aprove em:\n${base}/r/${grupo.codigo}`
      ).catch(() => {});
    }
    res.json({ ok: true, gastoId, status });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/aprovar', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    if (grupo.criado_por !== req.body.telefone) return res.status(403).json({ error: 'Sem permissão' });
    await db.aprovarGasto(req.params.gastoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/rejeitar', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    if (grupo.criado_por !== req.body.telefone) return res.status(403).json({ error: 'Sem permissão' });
    await db.rejeitarGasto(req.params.gastoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/confirmar', upload.single('comprovante'), async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone, nome } = req.body;
    const comprovanteUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await db.confirmarPagamento(req.params.gastoId, telefone, comprovanteUrl);
    const gasto = await db.getGasto(req.params.gastoId);
    if (gasto) {
      const base = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
      await enviarMensagem(grupo.criado_por,
        `💰 *${nome}* confirmou pagamento de "${gasto.descricao}". Valide em:\n${base}/r/${grupo.codigo}`
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/validar', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone_criador, telefone_devedor } = req.body;
    if (grupo.criado_por !== telefone_criador) return res.status(403).json({ error: 'Sem permissão' });
    await db.validarPagamento(req.params.gastoId, telefone_devedor);
    await enviarMensagem(telefone_devedor, '✅ Seu pagamento foi confirmado!').catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/r/:codigo/gasto/:gastoId/rejeitar-pagamento', async (req, res) => {
  try {
    const grupo = await db.verificarCodigo(req.params.codigo);
    if (!grupo) return res.status(404).json({ error: 'Não encontrado' });
    const { telefone_criador, telefone_devedor } = req.body;
    if (grupo.criado_por !== telefone_criador) return res.status(403).json({ error: 'Sem permissão' });
    await db.rejeitarPagamento(req.params.gastoId, telefone_devedor);
    await enviarMensagem(telefone_devedor, '⚠️ Seu comprovante foi rejeitado. Envie novamente na página do rateio.').catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// SPA — serve o HTML estático
app.get('/r/:codigo', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/app.html'));
});

app.get('/', (_req, res) => res.send('Splitry rodando!'));

db.init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}).catch(err => { console.error('Erro banco:', err); process.exit(1); });
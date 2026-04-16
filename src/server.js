require('dotenv').config();
const express = require('express');
const { handleMetaMessage } = require('./bot');

const app = express();
app.use(express.json());

// ─── Verificação do webhook da Meta ──────────────────────────
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verificado com sucesso!');
    res.status(200).send(challenge);
  } else {
    console.error('Falha na verificação do webhook');
    res.sendStatus(403);
  }
});

// ─── Recebe mensagens da Meta ─────────────────────────────────
app.post('/webhook/meta', async (req, res) => {
  // Responde 200 imediatamente para a Meta não reenviar
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

          const from = message.from;         // número de quem enviou
          const text = message.text.body;    // texto da mensagem
          const groupId = value.metadata?.phone_number_id; // sempre o mesmo
          const contacts = value.contacts || [];
          const nomeRemetente = contacts.find(c => c.wa_id === from)?.profile?.name || null;

          console.log(`[${new Date().toISOString()}] ${from} (${nomeRemetente}): ${text}`);

          await handleMetaMessage(from, text, nomeRemetente);
        }
      }
    }
  } catch (err) {
    console.error('Erro ao processar mensagem:', err);
  }
});

app.get('/', (_req, res) => res.send('Splitwise Bot (Meta) rodando!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

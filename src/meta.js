const axios = require('axios');

const BASE_URL = `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`;

async function enviarMensagem(para, texto) {
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to: para,
      type: 'text',
      text: { body: texto }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Mensagem enviada para ${para}`);
  } catch (err) {
    console.error(`Erro ao enviar para ${para}:`, err.response?.data || err.message);
  }
}

module.exports = { enviarMensagem };

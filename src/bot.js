const { GoogleGenerativeAI } = require('@google/generative-ai');
// const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const { enviarMensagem } = require('./meta');

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Você é um bot de divisão de despesas via WhatsApp chamado Splitry.

As pessoas criam rateios, compartilham um link web, e os devedores confirmam pagamentos na página.

== ONBOARDING ==
Se usuário não tem nome, pergunte o nome primeiro.
Se não tem rateio, pergunte se quer CRIAR ou ENTRAR (com código).
Formato rápido: "Yan, Jantar ontem" (nome + criar) ou "Yan, ABC12" (nome + entrar)

== CRIAR RATEIO ==
Quando o usuário disser "criar [nome]" ou no onboarding com nome de grupo:
Responda EXATAMENTE assim (use {{LINK}} onde o link vai aparecer):
"Rateio *[nome]* criado! 🎉

Compartilhe o link com quem participou:
{{LINK}}

Quando quiser registrar um gasto, diga:
gastei [valor] em [descrição]"

== REGISTRAR GASTO ==
Exemplos:
- "gastei 80 no uber" → divide igual entre todos
- "paguei 120 de jantar, João 40, Maria 40, Pedro 40" → divisão personalizada

Quem enviou = quem pagou. Divisão padrão = igual entre todos.

Resposta após registrar:
"✓ R$[valor] de [descrição] registrado
[Nome] pagou → R$[parte] para cada um

Os devedores foram notificados com o link para confirmar."

== SALDO ==
"saldo", "quem deve", "resumo":
"💸 [Nome do rateio]
[A] deve R$X para [B]
Total pendente: R$X"

== REGRAS ==
- Máximo 8 linhas por resposta
- Nunca invente valores ou nomes
- Português do Brasil
- Emojis: máximo 1 por resposta

== SAÍDA ESTRUTURADA ==
SEMPRE termine com JSON entre <<<JSON>>> e <<<END>>>. Nunca omita.

Onboarding (nome + criar):
<<<JSON>>>
{"type":"onboard","name":"Yan","action":"create","group_name":"Jantar ontem"}
<<<END>>>

Onboarding (nome + entrar):
<<<JSON>>>
{"type":"onboard","name":"Yan","action":"join","code":"ABC12"}
<<<END>>>

Salvar nome:
<<<JSON>>>
{"type":"set_name","name":"Yan"}
<<<END>>>

Criar rateio:
<<<JSON>>>
{"type":"create_group","group_name":"Jantar ontem"}
<<<END>>>

Entrar em rateio:
<<<JSON>>>
{"type":"join_group","code":"ABC12"}
<<<END>>>

Gasto divisão igual:
<<<JSON>>>
{"type":"expense","amount":80,"description":"uber","category":"Transporte","split":"equal"}
<<<END>>>

Gasto divisão personalizada:
<<<JSON>>>
{"type":"expense","amount":120,"description":"jantar","category":"Alimentação","split":"custom","parcelas":[{"nome":"João","valor":40},{"nome":"Maria","valor":40},{"nome":"Pedro","valor":40}]}
<<<END>>>

Trocar rateio ativo:
<<<JSON>>>
{"type":"set_active_group","grupo_id":2}
<<<END>>>

Mensagem normal:
<<<JSON>>>
{"type":"message"}
<<<END>>>`;

async function handleMetaMessage(telefone, mensagem, nomeWhatsApp) {
  const usuario = await db.garantirUsuario(telefone, nomeWhatsApp);

  const pre = preprocessar(telefone, mensagem, usuario);
  if (pre) {
    const resposta = await handlePreProcessado(pre, telefone, usuario);
    await enviarMensagem(telefone, resposta);
    return;
  }

  const grupoAtivo = await db.getGrupoAtivo(telefone);
  const grupos = await db.getGruposDoUsuario(telefone);
  const contexto = await buildContexto(usuario, grupoAtivo, grupos);
  const grupoId = grupoAtivo?.id || null;
  const historico = await db.getHistorico(telefone, grupoId);

  await db.salvarMensagem(telefone, grupoId, 'user', mensagem);

  const messages = [
    ...historico.map(h => ({ role: h.role, content: h.conteudo })),
    { role: 'user', content: mensagem }
  ];

  // ==== GEMINI ====
  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const prompt = SYSTEM_PROMPT + '\n\n' + contexto + '\n\nConversa:\n' +
    messages.map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`).join('\n') +
    '\nAssistente:';
  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  // ==== ANTHROPIC (descomente para reativar) ====
  // const response = await anthropic.messages.create({
  //   model: 'claude-sonnet-4-20250514',
  //   max_tokens: 1000,
  //   system: SYSTEM_PROMPT + '\n\n' + contexto,
  //   messages,
  // });
  // const raw = response.content.map(b => b.text || '').join('');

  const { displayText, action } = parseReply(raw);
  let textoFinal = displayText;

  console.log('ACTION:', JSON.stringify(action));

  await processAction(action, telefone, usuario, grupoAtivo, grupos);

  const grupoFinal = await db.getGrupoAtivo(telefone);

  if (grupoFinal && (action.type === 'onboard' || action.type === 'create_group')) {
    const baseUrl = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
    const link = `${baseUrl}/r/${grupoFinal.codigo}`;
    textoFinal = textoFinal.replace(/\{\{LINK\}\}/g, link);
    if (!textoFinal.includes(grupoFinal.codigo)) {
      textoFinal += `\n\nLink do rateio:\n${link}`;
    }
  }

  await db.salvarMensagem(telefone, grupoFinal?.id || null, 'assistant', raw);
  await enviarMensagem(telefone, textoFinal);
}

function preprocessar(telefone, mensagem, usuario) {
  const texto = mensagem.trim();
  const matchEntrar = texto.match(/^entrar\s+([A-Z0-9]{4,6})$/i);
  if (matchEntrar) {
    const codigo = matchEntrar[1].toUpperCase();
    const temNome = usuario && !usuario.nome.startsWith('User_');
    return temNome ? { tipo: 'join_direto', codigo } : { tipo: 'join_sem_nome', codigo };
  }
  const matchNomeCodigo = texto.match(/^([^,]+),\s*([A-Z0-9]{4,6})$/i);
  if (matchNomeCodigo) {
    return { tipo: 'onboard_join', nome: matchNomeCodigo[1].trim(), codigo: matchNomeCodigo[2].toUpperCase() };
  }
  return null;
}

async function handlePreProcessado(pre, telefone, usuario) {
  const baseUrl = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';

  if (pre.tipo === 'join_direto') {
    const grupo = await db.entrarGrupo(pre.codigo, telefone, usuario.nome);
    if (grupo) {
      const membros = await db.getMembros(grupo.id);
      return `Entrou no rateio *${grupo.nome}*! 👋\nMembros: ${membros.map(m => m.nome).join(', ')}\n\nAcompanhe aqui:\n${baseUrl}/r/${grupo.codigo}`;
    }
    return `Código *${pre.codigo}* não encontrado.`;
  }

  if (pre.tipo === 'onboard_join') {
    await db.salvarUsuario(telefone, pre.nome);
    const grupo = await db.entrarGrupo(pre.codigo, telefone, pre.nome);
    if (grupo) {
      const membros = await db.getMembros(grupo.id);
      return `Olá, *${pre.nome}*! Entrou no rateio *${grupo.nome}*.\nMembros: ${membros.map(m => m.nome).join(', ')}\n\nAcompanhe aqui:\n${baseUrl}/r/${grupo.codigo}`;
    }
    return `Olá, *${pre.nome}*! Código *${pre.codigo}* não encontrado.`;
  }

  return 'Como posso te chamar?';
}

async function buildContexto(usuario, grupoAtivo, grupos) {
  const temNome = usuario.nome && !usuario.nome.startsWith('User_');
  let ctx = `ESTADO\nNome: ${temNome ? usuario.nome : 'NÃO CADASTRADO'}\n`;
  ctx += `Rateios: ${grupos.length > 0 ? grupos.map(g => `[${g.id}] ${g.nome} (${g.codigo})`).join(', ') : 'NENHUM'}\n`;

  if (grupoAtivo) {
    const [membros, saldo] = await Promise.all([
      db.getMembros(grupoAtivo.id),
      db.getSaldoGrupo(grupoAtivo.id)
    ]);
    const baseUrl = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
    ctx += `\nRATEIO ATIVO: ${grupoAtivo.nome} (código: ${grupoAtivo.codigo})\n`;
    ctx += `Link: ${baseUrl}/r/${grupoAtivo.codigo}\n`;
    ctx += `Membros (${membros.length}): ${membros.map(m => m.nome).join(', ')}\n`;
    ctx += `Saldo: ${saldo.length === 0 ? 'zerado' : saldo.map(s => `${s.devedor_nome} deve R$${parseFloat(s.total).toFixed(2)} para ${s.pago_por_nome}`).join(' | ')}\n`;
  }

  ctx += `Hoje: ${new Date().toISOString().split('T')[0]}`;
  return ctx;
}

function parseReply(raw) {
  const match = raw.match(/<<<JSON>>>([\s\S]*?)<<<END>>>/);
  let action = { type: 'message' };
  let displayText = raw.replace(/<<<JSON>>>[\s\S]*?<<<END>>>/g, '').trim();
  if (match) {
    try { action = JSON.parse(match[1].trim()); } catch (e) { console.error('JSON inválido:', match[1]); }
  }
  return { displayText, action };
}

async function processAction(action, telefone, usuario, grupoAtivo, grupos) {
  try {
    switch (action.type) {
      case 'onboard': {
        const nome = action.name;
        if (nome) await db.salvarUsuario(telefone, nome);
        const nomeAtual = nome || usuario.nome;
        if (action.action === 'create' && action.group_name) {
          await db.criarGrupo(action.group_name, telefone, nomeAtual);
        } else if (action.action === 'join' && action.code) {
          await db.entrarGrupo(action.code, telefone, nomeAtual);
        }
        break;
      }
      case 'set_name':
        if (action.name) await db.salvarUsuario(telefone, action.name);
        break;
      case 'create_group':
        if (action.group_name) {
          const nome = (await db.getUsuario(telefone))?.nome || usuario.nome;
          await db.criarGrupo(action.group_name, telefone, nome);
        }
        break;
      case 'join_group':
        if (action.code) {
          const nome = (await db.getUsuario(telefone))?.nome || usuario.nome;
          await db.entrarGrupo(action.code, telefone, nome);
        }
        break;
      case 'set_active_group':
        if (action.grupo_id) await db.setGrupoAtivo(telefone, action.grupo_id);
        break;
      case 'expense': {
        if (!grupoAtivo || !action.amount) break;
        const pagadorNome = (await db.getUsuario(telefone))?.nome || usuario.nome;
        const membros = await db.getMembros(grupoAtivo.id);
        let parcelas = [];

        if (action.split === 'equal') {
          const parte = action.amount / membros.length;
          parcelas = membros
            .filter(m => m.telefone !== telefone)
            .map(m => ({ telefone: m.telefone, nome: m.nome, valor: parte }));
        } else if (action.split === 'custom' && action.parcelas) {
          for (const p of action.parcelas) {
            const membro = membros.find(m => m.nome.toLowerCase().includes(p.nome.toLowerCase()) && m.telefone !== telefone);
            if (membro) parcelas.push({ telefone: membro.telefone, nome: membro.nome, valor: p.valor });
          }
        }

        if (parcelas.length > 0) {
          await db.salvarGasto(grupoAtivo.id, action.description, action.amount, telefone, pagadorNome, parcelas);
          console.log(`Gasto salvo: R$${action.amount} - ${action.description}`);
          const baseUrl = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
          const link = `${baseUrl}/r/${grupoAtivo.codigo}`;
          for (const p of parcelas) {
            await enviarMensagem(p.telefone,
              `💸 *${pagadorNome}* pagou R$${parseFloat(action.amount).toFixed(2)} de ${action.description}\nSua parte: R$${parseFloat(p.valor).toFixed(2)}\n\nConfirme o pagamento aqui:\n${link}`
            );
          }
        }
        break;
      }
    }
  } catch (err) { console.error('Erro processAction:', action.type, err); }
}

module.exports = { handleMetaMessage };
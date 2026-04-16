const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./database');
const { enviarMensagem } = require('./meta');

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `Você é o Splitry, um bot de divisão de despesas via WhatsApp.

Sua única função é criar rateios e enviar o link para as pessoas gerenciarem tudo na página web.
NÃO registre gastos, NÃO calcule saldos, NÃO processe pagamentos — tudo isso é feito na página.

== FLUXO ==

1. Se usuário não tem nome → peça o nome
2. Se não tem rateio → pergunte se quer CRIAR ou ENTRAR (com código)
3. Ao criar → responda com o link (use {{LINK}})
4. Ao entrar → confirme e mande o link

Formato rápido aceito:
- "Yan, Jantar ontem" → salva nome + cria rateio
- "Yan, ABC12" → salva nome + entra no rateio

== RESPOSTAS ==

Ao criar rateio:
"Rateio *[nome]* criado! 🎉

Acesse e gerencie tudo pelo link:
{{LINK}}

Compartilhe com quem participou para eles entrarem e lançarem os gastos."

Ao entrar em rateio:
"Entrou no rateio *[nome]*! 👋

Acesse aqui:
{{LINK}}"

Para qualquer pergunta sobre gastos, saldo, pagamentos:
"Tudo isso você gerencia diretamente na página:
[link do rateio ativo]"

== REGRAS ==
- Máximo 6 linhas por resposta
- Português do Brasil
- Nunca calcule saldos ou registre gastos aqui

== SAÍDA ESTRUTURADA ==
SEMPRE termine com JSON entre <<<JSON>>> e <<<END>>>.

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

Trocar rateio ativo:
<<<JSON>>>
{"type":"set_active_group","grupo_id":2}
<<<END>>>

Mensagem normal (redireciona para a página):
<<<JSON>>>
{"type":"message"}
<<<END>>>`;

async function handleMetaMessage(telefone, mensagem, nomeWhatsApp) {
  const usuario = await db.garantirUsuario(telefone, nomeWhatsApp);

  // Pré-processa comandos diretos
  const pre = preprocessar(mensagem, usuario);
  if (pre) {
    const resposta = await handlePreProcessado(pre, telefone, usuario);
    await enviarMensagem(telefone, resposta);
    return;
  }

  const grupoAtivo = await db.getGrupoAtivo(telefone);
  const grupos = await db.getGruposDoUsuario(telefone);
  const contexto = buildContexto(usuario, grupoAtivo, grupos);
  const grupoId = grupoAtivo?.id || null;
  const historico = await db.getHistorico(telefone, grupoId);

  await db.salvarMensagem(telefone, grupoId, 'user', mensagem);

  const messages = [
    ...historico.map(h => ({ role: h.role, content: h.conteudo })),
    { role: 'user', content: mensagem }
  ];

  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const prompt = SYSTEM_PROMPT + '\n\n' + contexto + '\n\nConversa:\n' +
    messages.map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`).join('\n') +
    '\nAssistente:';
  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  const { displayText, action } = parseReply(raw);
  let textoFinal = displayText;

  console.log('ACTION:', JSON.stringify(action));

  await processAction(action, telefone, usuario);

  const grupoFinal = await db.getGrupoAtivo(telefone);

  // Injeta link em qualquer resposta que tenha {{LINK}}
  if (grupoFinal) {
    const link = buildLink(grupoFinal.codigo);
    textoFinal = textoFinal.replace(/\{\{LINK\}\}/g, link);
    // Se perguntarem sobre gastos/saldo, sempre inclui o link
    if (action.type === 'message' && grupoFinal) {
      if (!textoFinal.includes('http')) {
        textoFinal += `\n\n${link}`;
      }
    }
  }

  await db.salvarMensagem(telefone, grupoFinal?.id || null, 'assistant', raw);
  await enviarMensagem(telefone, textoFinal);
}

function buildLink(codigo) {
  const base = process.env.BASE_URL || 'https://splitry-bot-production.up.railway.app';
  return `${base}/r/${codigo}`;
}

function preprocessar(mensagem, usuario) {
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
  if (pre.tipo === 'join_direto') {
    const grupo = await db.entrarGrupo(pre.codigo, telefone, usuario.nome);
    if (grupo) {
      const membros = await db.getMembros(grupo.id);
      return `Entrou no rateio *${grupo.nome}*! 👋\nMembros: ${membros.map(m => m.nome).join(', ')}\n\nAcesse aqui:\n${buildLink(grupo.codigo)}`;
    }
    return `Código *${pre.codigo}* não encontrado. Verifique e tente novamente.`;
  }

  if (pre.tipo === 'onboard_join') {
    await db.salvarUsuario(telefone, pre.nome);
    const grupo = await db.entrarGrupo(pre.codigo, telefone, pre.nome);
    if (grupo) {
      const membros = await db.getMembros(grupo.id);
      return `Olá, *${pre.nome}*! Entrou no rateio *${grupo.nome}*.\nMembros: ${membros.map(m => m.nome).join(', ')}\n\nAcesse aqui:\n${buildLink(grupo.codigo)}`;
    }
    return `Olá, *${pre.nome}*! Código *${pre.codigo}* não encontrado.`;
  }

  return 'Como posso te chamar?';
}

function buildContexto(usuario, grupoAtivo, grupos) {
  const temNome = usuario.nome && !usuario.nome.startsWith('User_');
  let ctx = `ESTADO\nNome: ${temNome ? usuario.nome : 'NÃO CADASTRADO'}\n`;
  ctx += `Rateios: ${grupos.length > 0 ? grupos.map(g => `[${g.id}] ${g.nome} (${g.codigo}) — link: ${buildLink(g.codigo)}`).join(', ') : 'NENHUM'}\n`;
  if (grupoAtivo) {
    ctx += `\nRATEIO ATIVO: ${grupoAtivo.nome} (código: ${grupoAtivo.codigo})\n`;
    ctx += `Link: ${buildLink(grupoAtivo.codigo)}\n`;
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

async function processAction(action, telefone, usuario) {
  try {
    switch (action.type) {
      case 'onboard': {
        if (action.name) await db.salvarUsuario(telefone, action.name);
        const nome = action.name || usuario.nome;
        if (action.action === 'create' && action.group_name) await db.criarGrupo(action.group_name, telefone, nome);
        else if (action.action === 'join' && action.code) await db.entrarGrupo(action.code, telefone, nome);
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
    }
  } catch (err) { console.error('Erro processAction:', action.type, err); }
}

module.exports = { handleMetaMessage };
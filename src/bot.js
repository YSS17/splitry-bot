const { GoogleGenerativeAI } = require('@google/generative-ai');
// const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const { enviarMensagem } = require('./meta');

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Você é um bot de divisão de despesas que funciona em conversas individuais do WhatsApp.

As pessoas criam grupos financeiros com um código, convidam amigos, e registram gastos.
Cada pessoa conversa individualmente com você, mas todas estão no mesmo grupo financeiro.

== ONBOARDING ==
Se usuário não tem nome cadastrado, peça o nome primeiro.
Se não tem grupo, pergunte se quer CRIAR ou ENTRAR (com código).

Formato onboarding rápido aceito: "Yan, Viagem Lisboa" (nome + criar grupo) ou "Yan, ABC12" (nome + entrar)

== REGISTRAR GASTO ==
Exemplos: "gastei 80 no uber", "paguei 120 de jantar divide João 40 Maria 40 Pedro 40"

Quem enviou = quem pagou.
Divisão padrão = igual entre todos do grupo.
Divisão personalizada = a pessoa especifica quanto cada um deve.

Resposta após registrar:
"✓ R$80 de uber registrado
Yan pagou

💸 Divisão:
· João — R$40
· Maria — R$40

Para confirmar pagamento, os devedores devem dizer: paguei"

== CONFIRMAR PAGAMENTO ==
Quando devedor disser "paguei", "já paguei", "quitei":
→ Marque como pago e mostre status atualizado

== SALDO ==
"saldo", "quem deve", "resumo":
"💸 Saldo do grupo [Nome]

João deve R$40 para Yan
Maria deve R$80 para Pedro

Total pendente: R$120"

Se zerado: "Tudo certo! Ninguém deve nada ✓"

== GRUPOS ==
- Criar: use {{CODIGO}} onde o código deve aparecer
- Entrar: confirme com nome do grupo e membros
- Listar: se tiver vários grupos, mostre e pergunte qual usar

== REGRAS ==
- Máximo 6 linhas por resposta
- Nunca invente valores ou nomes
- Português do Brasil
- Se dúvida sobre quem divide, pergunte
- Emojis: máximo 1 por resposta

== SAÍDA ESTRUTURADA ==
SEMPRE termine com JSON entre <<<JSON>>> e <<<END>>>.

Onboarding (nome + criar grupo):
<<<JSON>>>
{"type":"onboard","name":"Yan","action":"create","group_name":"Viagem Lisboa"}
<<<END>>>

Onboarding (nome + entrar):
<<<JSON>>>
{"type":"onboard","name":"Yan","action":"join","code":"ABC12"}
<<<END>>>

Salvar nome:
<<<JSON>>>
{"type":"set_name","name":"Yan"}
<<<END>>>

Criar grupo:
<<<JSON>>>
{"type":"create_group","group_name":"Viagem Lisboa"}
<<<END>>>

Entrar em grupo:
<<<JSON>>>
{"type":"join_group","code":"ABC12"}
<<<END>>>

Gasto (divisão igual entre todos):
<<<JSON>>>
{"type":"expense","amount":80,"description":"uber","category":"Transporte","split":"equal"}
<<<END>>>

Gasto (divisão personalizada):
<<<JSON>>>
{"type":"expense","amount":120,"description":"jantar","category":"Alimentação","split":"custom","parcelas":[{"nome":"João","valor":40},{"nome":"Maria","valor":40},{"nome":"Pedro","valor":40}]}
<<<END>>>

Confirmar pagamento do último gasto:
<<<JSON>>>
{"type":"payment_confirm"}
<<<END>>>

Trocar grupo ativo:
<<<JSON>>>
{"type":"set_active_group","grupo_id":2}
<<<END>>>

Mensagem normal:
<<<JSON>>>
{"type":"message"}
<<<END>>>`;

// ─── Handler principal ───────────────────────────────────────

async function handleMetaMessage(telefone, mensagem, nomeWhatsApp) {
  const usuario = db.garantirUsuario(telefone, nomeWhatsApp);

  // Pré-processa comandos diretos (entrar CODIGO)
  const pre = preprocessar(telefone, mensagem, usuario);
  if (pre) {
    const resposta = await handlePreProcessado(pre, telefone, usuario);
    await enviarMensagem(telefone, resposta);
    return;
  }

  const grupoAtivo = db.getGrupoAtivo(telefone);
  const grupos = db.getGruposDoUsuario(telefone);
  const contexto = buildContexto(usuario, grupoAtivo, grupos);
  const grupoId = grupoAtivo?.id || null;
  const historico = db.getHistorico(telefone, grupoId);

  db.salvarMensagem(telefone, grupoId, 'user', mensagem);

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

  const grupoFinal = db.getGrupoAtivo(telefone);

  // Injeta código real se criou grupo
  if (grupoFinal && (action.type === 'onboard' || action.type === 'create_group')) {
    textoFinal = textoFinal.replace(/\{\{CODIGO\}\}/g, grupoFinal.codigo);
    if (!textoFinal.includes(grupoFinal.codigo)) {
      textoFinal += `\n\nCódigo: *${grupoFinal.codigo}*\nPara convidar: envie "entrar ${grupoFinal.codigo}"`;
    }
  }

  db.salvarMensagem(telefone, grupoFinal?.id || null, 'assistant', raw);
  await enviarMensagem(telefone, textoFinal);
}

// ─── Pré-processamento ───────────────────────────────────────

function preprocessar(telefone, mensagem, usuario) {
  const texto = mensagem.trim();

  // "entrar CODIGO"
  const matchEntrar = texto.match(/^entrar\s+([A-Z0-9]{4,6})$/i);
  if (matchEntrar) {
    const codigo = matchEntrar[1].toUpperCase();
    const temNome = usuario && !usuario.nome.startsWith('User_');
    if (temNome) return { tipo: 'join_direto', codigo };
    return { tipo: 'join_sem_nome', codigo };
  }

  // "Nome, CODIGO" onde CODIGO existe no banco
  const matchNomeCodigo = texto.match(/^([^,]+),\s*([A-Z0-9]{4,6})$/i);
  if (matchNomeCodigo) {
    const nome = matchNomeCodigo[1].trim();
    const codigo = matchNomeCodigo[2].toUpperCase();
    if (db.verificarCodigo(codigo)) {
      return { tipo: 'onboard_join', nome, codigo };
    }
  }

  return null;
}

async function handlePreProcessado(pre, telefone, usuario) {
  if (pre.tipo === 'join_direto') {
    const grupo = db.entrarGrupo(pre.codigo, telefone, usuario.nome);
    if (grupo) {
      const membros = db.getMembros(grupo.id);
      return `Entrou no grupo *${grupo.nome}*! 👋\nMembros: ${membros.map(m => m.nome).join(', ')}`;
    }
    return `Código *${pre.codigo}* não encontrado. Verifique e tente novamente.`;
  }

  if (pre.tipo === 'onboard_join') {
    db.salvarUsuario(telefone, pre.nome);
    const grupo = db.entrarGrupo(pre.codigo, telefone, pre.nome);
    if (grupo) {
      const membros = db.getMembros(grupo.id);
      return `Olá, *${pre.nome}*! Entrou no grupo *${grupo.nome}*.\nMembros: ${membros.map(m => m.nome).join(', ')}`;
    }
    return `Olá, *${pre.nome}*! Código *${pre.codigo}* não encontrado.`;
  }

  return 'Como posso te chamar? E qual o nome do seu grupo?';
}

// ─── Contexto ────────────────────────────────────────────────

function buildContexto(usuario, grupoAtivo, grupos) {
  const temNome = usuario.nome && !usuario.nome.startsWith('User_');
  let ctx = `ESTADO\nNome: ${temNome ? usuario.nome : 'NÃO CADASTRADO'}\n`;
  ctx += `Grupos: ${grupos.length > 0 ? grupos.map(g => `[${g.id}] ${g.nome} (${g.codigo})`).join(', ') : 'NENHUM'}\n`;

  if (grupoAtivo) {
    const membros = db.getMembros(grupoAtivo.id);
    const saldo = db.getSaldoGrupo(grupoAtivo.id);
    ctx += `\nGRUPO ATIVO: ${grupoAtivo.nome} (código: ${grupoAtivo.codigo})\n`;
    ctx += `Membros (${membros.length}): ${membros.map(m => m.nome).join(', ')}\n`;
    ctx += `Saldo: ${saldo.length === 0 ? 'zerado' :
      saldo.map(s => `${s.devedor_nome} deve R$${s.total.toFixed(2)} para ${s.pago_por_nome}`).join(' | ')}\n`;
  }

  ctx += `Hoje: ${new Date().toISOString().split('T')[0]}`;
  return ctx;
}

// ─── Parse ───────────────────────────────────────────────────

function parseReply(raw) {
  const match = raw.match(/<<<JSON>>>([\s\S]*?)<<<END>>>/);
  let action = { type: 'message' };
  let displayText = raw.replace(/<<<JSON>>>[\s\S]*?<<<END>>>/g, '').trim();
  if (match) {
    try { action = JSON.parse(match[1].trim()); } catch (e) {
      console.error('JSON inválido:', match[1]);
    }
  }
  return { displayText, action };
}

// ─── Processa ações ──────────────────────────────────────────

async function processAction(action, telefone, usuario, grupoAtivo, grupos) {
  try {
    switch (action.type) {

      case 'onboard': {
        const nome = action.name;
        if (nome) db.salvarUsuario(telefone, nome);
        const nomeAtual = nome || usuario.nome;
        if (action.action === 'create' && action.group_name) {
          db.criarGrupo(action.group_name, telefone, nomeAtual);
        } else if (action.action === 'join' && action.code) {
          db.entrarGrupo(action.code, telefone, nomeAtual);
        }
        break;
      }

      case 'set_name':
        if (action.name) db.salvarUsuario(telefone, action.name);
        break;

      case 'create_group':
        if (action.group_name) {
          const nome = db.getUsuario(telefone)?.nome || usuario.nome;
          db.criarGrupo(action.group_name, telefone, nome);
        }
        break;

      case 'join_group':
        if (action.code) {
          const nome = db.getUsuario(telefone)?.nome || usuario.nome;
          db.entrarGrupo(action.code, telefone, nome);
        }
        break;

      case 'set_active_group':
        if (action.grupo_id) db.setGrupoAtivo(telefone, action.grupo_id);
        break;

      case 'expense': {
        if (!grupoAtivo || !action.amount) break;
        const pagadorNome = db.getUsuario(telefone)?.nome || usuario.nome;
        const membros = db.getMembros(grupoAtivo.id);

        let parcelas = [];

        if (action.split === 'equal') {
          // Divide igual entre todos
          const parte = action.amount / membros.length;
          parcelas = membros
            .filter(m => m.telefone !== telefone)
            .map(m => ({ telefone: m.telefone, nome: m.nome, valor: parte }));
        } else if (action.split === 'custom' && action.parcelas) {
          // Divisão personalizada — tenta casar nomes com membros
          for (const p of action.parcelas) {
            const membro = membros.find(m =>
              m.nome.toLowerCase().includes(p.nome.toLowerCase()) && m.telefone !== telefone
            );
            if (membro) {
              parcelas.push({ telefone: membro.telefone, nome: membro.nome, valor: p.valor });
            }
          }
        }

        if (parcelas.length > 0) {
          db.salvarGasto(grupoAtivo.id, action.description, action.amount, telefone, pagadorNome, parcelas);
          console.log(`Gasto salvo: R$${action.amount} - ${action.description}`);

          // Notifica devedores
          for (const p of parcelas) {
            const msg = `💸 *${pagadorNome}* pagou R$${action.amount.toFixed(2)} de ${action.description}\nSua parte: R$${p.valor.toFixed(2)}\n\nPara confirmar pagamento, responda: *paguei*`;
            await enviarMensagem(p.telefone, msg);
          }
        }
        break;
      }

      case 'payment_confirm': {
        if (!grupoAtivo) break;
        // Encontra gasto pendente mais recente para este devedor
        const ultimo = db.getUltimoGasto(grupoAtivo.id);
        if (ultimo) {
          db.confirmarPagamento(ultimo.id, telefone);
          console.log(`Pagamento confirmado: ${telefone} no gasto ${ultimo.id}`);

          // Notifica o credor
          const parcelas = db.getParcelas(ultimo.id);
          const minhaParcela = parcelas.find(p => p.devedor_telefone === telefone);
          if (minhaParcela) {
            const devedorNome = db.getUsuario(telefone)?.nome || 'Alguém';
            await enviarMensagem(ultimo.pago_por_telefone,
              `✅ *${devedorNome}* confirmou pagamento de R$${minhaParcela.valor.toFixed(2)} de ${ultimo.descricao}`
            );
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('Erro processAction:', action.type, err);
  }
}

module.exports = { handleMetaMessage };

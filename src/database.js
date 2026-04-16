const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      telefone TEXT PRIMARY KEY,
      nome TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grupos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      codigo TEXT UNIQUE NOT NULL,
      criado_por TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS membros_grupo (
      grupo_id INTEGER NOT NULL,
      telefone TEXT NOT NULL,
      nome TEXT NOT NULL,
      PRIMARY KEY (grupo_id, telefone)
    );

    CREATE TABLE IF NOT EXISTS gastos (
      id SERIAL PRIMARY KEY,
      grupo_id INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      valor_total NUMERIC NOT NULL,
      pago_por_telefone TEXT NOT NULL,
      pago_por_nome TEXT NOT NULL,
      data DATE DEFAULT CURRENT_DATE,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS parcelas (
      id SERIAL PRIMARY KEY,
      gasto_id INTEGER NOT NULL,
      devedor_telefone TEXT NOT NULL,
      devedor_nome TEXT NOT NULL,
      valor NUMERIC NOT NULL,
      pago BOOLEAN DEFAULT FALSE,
      comprovante_url TEXT,
      confirmado_em TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS grupo_ativo (
      telefone TEXT PRIMARY KEY,
      grupo_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS historico (
      id SERIAL PRIMARY KEY,
      telefone TEXT NOT NULL,
      grupo_id INTEGER,
      role TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Banco PostgreSQL iniciado!');
}

// ─── Usuários ────────────────────────────────────────────────

async function getUsuario(telefone) {
  const r = await query('SELECT * FROM usuarios WHERE telefone = $1', [telefone]);
  return r.rows[0] || null;
}

async function salvarUsuario(telefone, nome) {
  await query(`
    INSERT INTO usuarios (telefone, nome) VALUES ($1, $2)
    ON CONFLICT (telefone) DO UPDATE SET nome = $2
  `, [telefone, nome]);
  await query('UPDATE membros_grupo SET nome = $1 WHERE telefone = $2', [nome, telefone]);
  return getUsuario(telefone);
}

async function garantirUsuario(telefone, nomeWhatsApp) {
  const u = await getUsuario(telefone);
  if (!u) {
    const nome = nomeWhatsApp || `User_${telefone.slice(-4)}`;
    await query('INSERT INTO usuarios (telefone, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING', [telefone, nome]);
  } else if (nomeWhatsApp && u.nome.startsWith('User_')) {
    await salvarUsuario(telefone, nomeWhatsApp);
  }
  return getUsuario(telefone);
}

// ─── Grupos ──────────────────────────────────────────────────

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

async function criarGrupo(nome, telefone, nomeUsuario) {
  let codigo;
  do {
    codigo = gerarCodigo();
    const existe = await query('SELECT id FROM grupos WHERE codigo = $1', [codigo]);
    if (existe.rows.length === 0) break;
  } while (true);

  const r = await query(
    'INSERT INTO grupos (nome, codigo, criado_por) VALUES ($1, $2, $3) RETURNING *',
    [nome, codigo, telefone]
  );
  const grupo = r.rows[0];
  await query('INSERT INTO membros_grupo (grupo_id, telefone, nome) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [grupo.id, telefone, nomeUsuario]);
  await setGrupoAtivo(telefone, grupo.id);
  return grupo;
}

async function entrarGrupo(codigo, telefone, nomeUsuario) {
  const r = await query('SELECT * FROM grupos WHERE codigo = $1', [codigo.toUpperCase()]);
  const grupo = r.rows[0];
  if (!grupo) return null;
  await query('INSERT INTO membros_grupo (grupo_id, telefone, nome) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [grupo.id, telefone, nomeUsuario]);
  await setGrupoAtivo(telefone, grupo.id);
  return grupo;
}

async function verificarCodigo(codigo) {
  const r = await query('SELECT * FROM grupos WHERE codigo = $1', [codigo.toUpperCase()]);
  return r.rows[0] || null;
}

async function getGrupo(grupoId) {
  const r = await query('SELECT * FROM grupos WHERE id = $1', [grupoId]);
  return r.rows[0] || null;
}

async function getGruposDoUsuario(telefone) {
  const r = await query(`
    SELECT g.* FROM grupos g
    JOIN membros_grupo m ON m.grupo_id = g.id
    WHERE m.telefone = $1 ORDER BY g.id DESC
  `, [telefone]);
  return r.rows;
}

async function getMembros(grupoId) {
  const r = await query('SELECT * FROM membros_grupo WHERE grupo_id = $1', [grupoId]);
  return r.rows;
}

async function setGrupoAtivo(telefone, grupoId) {
  await query(`
    INSERT INTO grupo_ativo (telefone, grupo_id) VALUES ($1, $2)
    ON CONFLICT (telefone) DO UPDATE SET grupo_id = $2
  `, [telefone, grupoId]);
}

async function getGrupoAtivo(telefone) {
  const r = await query('SELECT grupo_id FROM grupo_ativo WHERE telefone = $1', [telefone]);
  if (r.rows[0]) return getGrupo(r.rows[0].grupo_id);
  const grupos = await getGruposDoUsuario(telefone);
  return grupos.length > 0 ? grupos[0] : null;
}

// ─── Gastos ──────────────────────────────────────────────────

async function salvarGasto(grupoId, descricao, valorTotal, pagadorTel, pagadorNome, parcelas) {
  const r = await query(`
    INSERT INTO gastos (grupo_id, descricao, valor_total, pago_por_telefone, pago_por_nome)
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [grupoId, descricao, valorTotal, pagadorTel, pagadorNome]);

  const gastoId = r.rows[0].id;
  for (const p of parcelas) {
    await query(`
      INSERT INTO parcelas (gasto_id, devedor_telefone, devedor_nome, valor)
      VALUES ($1, $2, $3, $4)
    `, [gastoId, p.telefone, p.nome, p.valor]);
  }
  return gastoId;
}

async function getGasto(gastoId) {
  const r = await query('SELECT * FROM gastos WHERE id = $1', [gastoId]);
  return r.rows[0] || null;
}

async function getParcelas(gastoId) {
  const r = await query('SELECT * FROM parcelas WHERE gasto_id = $1', [gastoId]);
  return r.rows;
}

async function getUltimoGasto(grupoId) {
  const r = await query('SELECT * FROM gastos WHERE grupo_id = $1 ORDER BY id DESC LIMIT 1', [grupoId]);
  return r.rows[0] || null;
}

async function confirmarPagamento(gastoId, devedorTel, comprovanteUrl) {
  await query(`
    UPDATE parcelas SET pago = TRUE, confirmado_em = NOW(), comprovante_url = $3
    WHERE gasto_id = $1 AND devedor_telefone = $2
  `, [gastoId, devedorTel, comprovanteUrl || null]);
}

async function getSaldoGrupo(grupoId) {
  const r = await query(`
    SELECT p.devedor_telefone, p.devedor_nome,
           g.pago_por_telefone, g.pago_por_nome,
           SUM(p.valor) as total
    FROM parcelas p
    JOIN gastos g ON g.id = p.gasto_id
    WHERE g.grupo_id = $1 AND p.pago = FALSE
    GROUP BY p.devedor_telefone, p.devedor_nome, g.pago_por_telefone, g.pago_por_nome
  `, [grupoId]);
  return r.rows;
}

async function getGastosDoMes(grupoId) {
  const r = await query(`
    SELECT * FROM gastos
    WHERE grupo_id = $1 AND date_trunc('month', data) = date_trunc('month', CURRENT_DATE)
    ORDER BY id DESC
  `, [grupoId]);
  return r.rows;
}

// ─── Histórico ───────────────────────────────────────────────

async function getHistorico(telefone, grupoId, limite = 15) {
  const r = grupoId
    ? await query(`SELECT role, conteudo FROM historico WHERE telefone = $1 AND grupo_id = $2 ORDER BY id DESC LIMIT $3`, [telefone, grupoId, limite])
    : await query(`SELECT role, conteudo FROM historico WHERE telefone = $1 AND grupo_id IS NULL ORDER BY id DESC LIMIT $2`, [telefone, limite]);
  return r.rows.reverse();
}

async function salvarMensagem(telefone, grupoId, role, conteudo) {
  await query('INSERT INTO historico (telefone, grupo_id, role, conteudo) VALUES ($1, $2, $3, $4)', [telefone, grupoId, role, conteudo]);
  await query(`
    DELETE FROM historico WHERE telefone = $1 AND id NOT IN (
      SELECT id FROM historico WHERE telefone = $1 ORDER BY id DESC LIMIT 40
    )
  `, [telefone]);
}

module.exports = {
  init,
  getUsuario, salvarUsuario, garantirUsuario,
  criarGrupo, entrarGrupo, verificarCodigo, getGrupo, getGruposDoUsuario, getMembros,
  setGrupoAtivo, getGrupoAtivo,
  salvarGasto, getGasto, getParcelas, getUltimoGasto, confirmarPagamento,
  getSaldoGrupo, getGastosDoMes,
  getHistorico, salvarMensagem,
};
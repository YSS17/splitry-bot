const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
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
      proposto_por_telefone TEXT NOT NULL,
      proposto_por_nome TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      comprovante_url TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS participantes_gasto (
      gasto_id INTEGER NOT NULL,
      telefone TEXT NOT NULL,
      nome TEXT NOT NULL,
      valor NUMERIC NOT NULL,
      status_pagamento TEXT DEFAULT 'pendente',
      comprovante_url TEXT,
      confirmado_em TIMESTAMP,
      validado_em TIMESTAMP,
      PRIMARY KEY (gasto_id, telefone)
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
  console.log('PostgreSQL iniciado!');
}

// ─── Usuários ────────────────────────────────────────────────

async function getUsuario(telefone) {
  const r = await query('SELECT * FROM usuarios WHERE telefone = $1', [telefone]);
  return r.rows[0] || null;
}

async function salvarUsuario(telefone, nome) {
  await query('INSERT INTO usuarios (telefone, nome) VALUES ($1,$2) ON CONFLICT (telefone) DO UPDATE SET nome=$2', [telefone, nome]);
  await query('UPDATE membros_grupo SET nome=$1 WHERE telefone=$2', [nome, telefone]);
  return getUsuario(telefone);
}

async function garantirUsuario(telefone, nomeWhatsApp) {
  const u = await getUsuario(telefone);
  if (!u) {
    const nome = nomeWhatsApp || `User_${telefone.slice(-4)}`;
    await query('INSERT INTO usuarios (telefone, nome) VALUES ($1,$2) ON CONFLICT DO NOTHING', [telefone, nome]);
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
    const r = await query('SELECT id FROM grupos WHERE codigo=$1', [codigo]);
    if (r.rows.length === 0) break;
  } while (true);

  const r = await query('INSERT INTO grupos (nome, codigo, criado_por) VALUES ($1,$2,$3) RETURNING *', [nome, codigo, telefone]);
  const grupo = r.rows[0];
  await query('INSERT INTO membros_grupo (grupo_id, telefone, nome) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [grupo.id, telefone, nomeUsuario]);
  await setGrupoAtivo(telefone, grupo.id);
  return grupo;
}

async function entrarGrupo(codigo, telefone, nomeUsuario) {
  const r = await query('SELECT * FROM grupos WHERE codigo=$1', [codigo.toUpperCase()]);
  const grupo = r.rows[0];
  if (!grupo) return null;
  await query('INSERT INTO membros_grupo (grupo_id, telefone, nome) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [grupo.id, telefone, nomeUsuario]);
  await setGrupoAtivo(telefone, grupo.id);
  return grupo;
}

async function verificarCodigo(codigo) {
  const r = await query('SELECT * FROM grupos WHERE codigo=$1', [codigo.toUpperCase()]);
  return r.rows[0] || null;
}

async function getGrupo(id) {
  const r = await query('SELECT * FROM grupos WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function getGruposDoUsuario(telefone) {
  const r = await query('SELECT g.* FROM grupos g JOIN membros_grupo m ON m.grupo_id=g.id WHERE m.telefone=$1 ORDER BY g.id DESC', [telefone]);
  return r.rows;
}

async function getMembros(grupoId) {
  const r = await query('SELECT * FROM membros_grupo WHERE grupo_id=$1 ORDER BY nome', [grupoId]);
  return r.rows;
}

async function setGrupoAtivo(telefone, grupoId) {
  await query('INSERT INTO grupo_ativo (telefone, grupo_id) VALUES ($1,$2) ON CONFLICT (telefone) DO UPDATE SET grupo_id=$2', [telefone, grupoId]);
}

async function getGrupoAtivo(telefone) {
  const r = await query('SELECT grupo_id FROM grupo_ativo WHERE telefone=$1', [telefone]);
  if (r.rows[0]) return getGrupo(r.rows[0].grupo_id);
  const grupos = await getGruposDoUsuario(telefone);
  return grupos[0] || null;
}

// ─── Gastos ──────────────────────────────────────────────────

async function criarGasto(grupoId, descricao, valorTotal, propostoPorTel, propostoPorNome, participantes, status = 'pendente') {
  const r = await query(
    'INSERT INTO gastos (grupo_id, descricao, valor_total, proposto_por_telefone, proposto_por_nome, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [grupoId, descricao, valorTotal, propostoPorTel, propostoPorNome, status]
  );
  const gastoId = r.rows[0].id;
  for (const p of participantes) {
    await query(
      'INSERT INTO participantes_gasto (gasto_id, telefone, nome, valor) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [gastoId, p.telefone, p.nome, p.valor]
    );
  }
  return gastoId;
}

async function aprovarGasto(gastoId) {
  await query("UPDATE gastos SET status='aprovado' WHERE id=$1", [gastoId]);
}

async function rejeitarGasto(gastoId) {
  await query("UPDATE gastos SET status='rejeitado' WHERE id=$1", [gastoId]);
}

async function getGastos(grupoId) {
  const r = await query('SELECT * FROM gastos WHERE grupo_id=$1 ORDER BY criado_em DESC', [grupoId]);
  return r.rows;
}

async function getGasto(gastoId) {
  const r = await query('SELECT * FROM gastos WHERE id=$1', [gastoId]);
  return r.rows[0] || null;
}

async function getParticipantes(gastoId) {
  const r = await query('SELECT * FROM participantes_gasto WHERE gasto_id=$1', [gastoId]);
  return r.rows;
}

async function confirmarPagamento(gastoId, telefone, comprovanteUrl) {
  await query(
    "UPDATE participantes_gasto SET status_pagamento='aguardando_validacao', comprovante_url=$3, confirmado_em=NOW() WHERE gasto_id=$1 AND telefone=$2",
    [gastoId, telefone, comprovanteUrl || null]
  );
}

async function validarPagamento(gastoId, telefone) {
  await query(
    "UPDATE participantes_gasto SET status_pagamento='pago', validado_em=NOW() WHERE gasto_id=$1 AND telefone=$2",
    [gastoId, telefone]
  );
}

async function rejeitarPagamento(gastoId, telefone) {
  await query(
    "UPDATE participantes_gasto SET status_pagamento='pendente', comprovante_url=NULL, confirmado_em=NULL WHERE gasto_id=$1 AND telefone=$2",
    [gastoId, telefone]
  );
}

async function getSaldoGrupo(grupoId) {
  const r = await query(`
    SELECT pg.telefone as devedor_telefone, pg.nome as devedor_nome,
           g.proposto_por_telefone as credor_telefone, g.proposto_por_nome as credor_nome,
           SUM(pg.valor) as total
    FROM participantes_gasto pg
    JOIN gastos g ON g.id = pg.gasto_id
    WHERE g.grupo_id=$1 AND g.status='aprovado' AND pg.status_pagamento != 'pago'
    GROUP BY pg.telefone, pg.nome, g.proposto_por_telefone, g.proposto_por_nome
  `, [grupoId]);
  return r.rows;
}

// ─── Histórico ───────────────────────────────────────────────

async function getHistorico(telefone, grupoId, limite = 15) {
  const r = grupoId
    ? await query('SELECT role, conteudo FROM historico WHERE telefone=$1 AND grupo_id=$2 ORDER BY id DESC LIMIT $3', [telefone, grupoId, limite])
    : await query('SELECT role, conteudo FROM historico WHERE telefone=$1 AND grupo_id IS NULL ORDER BY id DESC LIMIT $2', [telefone, limite]);
  return r.rows.reverse();
}

async function salvarMensagem(telefone, grupoId, role, conteudo) {
  await query('INSERT INTO historico (telefone, grupo_id, role, conteudo) VALUES ($1,$2,$3,$4)', [telefone, grupoId, role, conteudo]);
  await query('DELETE FROM historico WHERE telefone=$1 AND id NOT IN (SELECT id FROM historico WHERE telefone=$1 ORDER BY id DESC LIMIT 40)', [telefone]);
}

module.exports = {
  init, query,
  getUsuario, salvarUsuario, garantirUsuario,
  criarGrupo, entrarGrupo, verificarCodigo, getGrupo, getGruposDoUsuario, getMembros,
  setGrupoAtivo, getGrupoAtivo,
  criarGasto, aprovarGasto, rejeitarGasto, getGastos, getGasto, getParticipantes,
  confirmarPagamento, validarPagamento, rejeitarPagamento, getSaldoGrupo,
  getHistorico, salvarMensagem,
};
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/splitwise.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    telefone TEXT PRIMARY KEY,
    nome TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT UNIQUE NOT NULL,
    criado_por TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS membros_grupo (
    grupo_id INTEGER NOT NULL,
    telefone TEXT NOT NULL,
    nome TEXT NOT NULL,
    PRIMARY KEY (grupo_id, telefone)
  );

  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo_id INTEGER NOT NULL,
    descricao TEXT NOT NULL,
    valor_total REAL NOT NULL,
    pago_por_telefone TEXT NOT NULL,
    pago_por_nome TEXT NOT NULL,
    data TEXT DEFAULT (date('now')),
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parcelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gasto_id INTEGER NOT NULL,
    devedor_telefone TEXT NOT NULL,
    devedor_nome TEXT NOT NULL,
    valor REAL NOT NULL,
    pago INTEGER DEFAULT 0,
    confirmado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS grupo_ativo (
    telefone TEXT PRIMARY KEY,
    grupo_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL,
    grupo_id INTEGER,
    role TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Usuários ────────────────────────────────────────────────

function getUsuario(telefone) {
  return db.prepare('SELECT * FROM usuarios WHERE telefone = ?').get(telefone);
}

function salvarUsuario(telefone, nome) {
  db.prepare('INSERT OR REPLACE INTO usuarios (telefone, nome) VALUES (?, ?)').run(telefone, nome);
  // Atualiza nome em todos os grupos
  db.prepare('UPDATE membros_grupo SET nome = ? WHERE telefone = ?').run(nome, telefone);
  return getUsuario(telefone);
}

function garantirUsuario(telefone, nomeWhatsApp) {
  const u = getUsuario(telefone);
  if (!u) {
    const nome = nomeWhatsApp || `User_${telefone.slice(-4)}`;
    db.prepare('INSERT OR IGNORE INTO usuarios (telefone, nome) VALUES (?, ?)').run(telefone, nome);
  } else if (nomeWhatsApp && u.nome.startsWith('User_')) {
    // Atualiza nome se ainda era placeholder
    salvarUsuario(telefone, nomeWhatsApp);
  }
  return getUsuario(telefone);
}

// ─── Grupos ──────────────────────────────────────────────────

function gerarCodigo() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function criarGrupo(nome, telefone, nomeUsuario) {
  let codigo;
  do { codigo = gerarCodigo(); }
  while (db.prepare('SELECT id FROM grupos WHERE codigo = ?').get(codigo));

  const r = db.prepare('INSERT INTO grupos (nome, codigo, criado_por) VALUES (?, ?, ?)').run(nome, codigo, telefone);
  db.prepare('INSERT OR IGNORE INTO membros_grupo (grupo_id, telefone, nome) VALUES (?, ?, ?)').run(r.lastInsertRowid, telefone, nomeUsuario);
  setGrupoAtivo(telefone, r.lastInsertRowid);
  return db.prepare('SELECT * FROM grupos WHERE id = ?').get(r.lastInsertRowid);
}

function entrarGrupo(codigo, telefone, nomeUsuario) {
  const grupo = db.prepare('SELECT * FROM grupos WHERE codigo = ?').get(codigo.toUpperCase());
  if (!grupo) return null;
  db.prepare('INSERT OR IGNORE INTO membros_grupo (grupo_id, telefone, nome) VALUES (?, ?, ?)').run(grupo.id, telefone, nomeUsuario);
  setGrupoAtivo(telefone, grupo.id);
  return grupo;
}

function verificarCodigo(codigo) {
  return db.prepare('SELECT * FROM grupos WHERE codigo = ?').get(codigo.toUpperCase()) || null;
}

function getGrupo(grupoId) {
  return db.prepare('SELECT * FROM grupos WHERE id = ?').get(grupoId);
}

function getGruposDoUsuario(telefone) {
  return db.prepare(`
    SELECT g.* FROM grupos g
    JOIN membros_grupo m ON m.grupo_id = g.id
    WHERE m.telefone = ? ORDER BY g.id DESC
  `).all(telefone);
}

function getMembros(grupoId) {
  return db.prepare('SELECT * FROM membros_grupo WHERE grupo_id = ?').all(grupoId);
}

function setGrupoAtivo(telefone, grupoId) {
  db.prepare('INSERT OR REPLACE INTO grupo_ativo (telefone, grupo_id) VALUES (?, ?)').run(telefone, grupoId);
}

function getGrupoAtivo(telefone) {
  const row = db.prepare('SELECT grupo_id FROM grupo_ativo WHERE telefone = ?').get(telefone);
  if (row) return getGrupo(row.grupo_id);
  const grupos = getGruposDoUsuario(telefone);
  return grupos.length > 0 ? grupos[0] : null;
}

// ─── Gastos ──────────────────────────────────────────────────

// parcelas = [{ telefone, nome, valor }]
function salvarGasto(grupoId, descricao, valorTotal, pagadorTel, pagadorNome, parcelas) {
  const r = db.prepare(`
    INSERT INTO gastos (grupo_id, descricao, valor_total, pago_por_telefone, pago_por_nome)
    VALUES (?, ?, ?, ?, ?)
  `).run(grupoId, descricao, valorTotal, pagadorTel, pagadorNome);

  const gastoId = r.lastInsertRowid;

  for (const p of parcelas) {
    if (p.telefone !== pagadorTel) {
      db.prepare(`
        INSERT INTO parcelas (gasto_id, devedor_telefone, devedor_nome, valor)
        VALUES (?, ?, ?, ?)
      `).run(gastoId, p.telefone, p.nome, p.valor);
    }
  }

  return gastoId;
}

function getGasto(gastoId) {
  return db.prepare('SELECT * FROM gastos WHERE id = ?').get(gastoId);
}

function getParcelas(gastoId) {
  return db.prepare('SELECT * FROM parcelas WHERE gasto_id = ?').all(gastoId);
}

function getUltimoGasto(grupoId) {
  return db.prepare('SELECT * FROM gastos WHERE grupo_id = ? ORDER BY id DESC LIMIT 1').get(grupoId);
}

function confirmarPagamento(gastoId, devedorTel) {
  const agora = new Date().toISOString();
  db.prepare(`
    UPDATE parcelas SET pago = 1, confirmado_em = ?
    WHERE gasto_id = ? AND devedor_telefone = ?
  `).run(agora, gastoId, devedorTel);
}

function getSaldoGrupo(grupoId) {
  // Retorna dívidas consolidadas entre pares de pessoas
  const parcelas = db.prepare(`
    SELECT p.devedor_telefone, p.devedor_nome, g.pago_por_telefone, g.pago_por_nome,
           SUM(p.valor) as total
    FROM parcelas p
    JOIN gastos g ON g.id = p.gasto_id
    WHERE g.grupo_id = ? AND p.pago = 0
    GROUP BY p.devedor_telefone, g.pago_por_telefone
  `).all(grupoId);

  return parcelas;
}

function getGastosDoMes(grupoId) {
  const inicio = new Date();
  inicio.setDate(1);
  return db.prepare('SELECT * FROM gastos WHERE grupo_id = ? AND data >= ?')
    .all(grupoId, inicio.toISOString().split('T')[0]);
}

// ─── Histórico ───────────────────────────────────────────────

function getHistorico(telefone, grupoId, limite = 15) {
  if (!grupoId) {
    return db.prepare(
      `SELECT role, conteudo FROM historico WHERE telefone = ? AND grupo_id IS NULL ORDER BY id DESC LIMIT ?`
    ).all(telefone, limite).reverse();
  }
  return db.prepare(
    `SELECT role, conteudo FROM historico WHERE telefone = ? AND grupo_id = ? ORDER BY id DESC LIMIT ?`
  ).all(telefone, grupoId, limite).reverse();
}

function salvarMensagem(telefone, grupoId, role, conteudo) {
  db.prepare('INSERT INTO historico (telefone, grupo_id, role, conteudo) VALUES (?,?,?,?)').run(telefone, grupoId, role, conteudo);
  db.prepare(`
    DELETE FROM historico WHERE telefone = ? AND id NOT IN (
      SELECT id FROM historico WHERE telefone = ? ORDER BY id DESC LIMIT 40
    )
  `).run(telefone, telefone);
}

module.exports = {
  getUsuario, salvarUsuario, garantirUsuario,
  criarGrupo, entrarGrupo, verificarCodigo, getGrupo, getGruposDoUsuario, getMembros,
  setGrupoAtivo, getGrupoAtivo,
  salvarGasto, getGasto, getParcelas, getUltimoGasto, confirmarPagamento,
  getSaldoGrupo, getGastosDoMes,
  getHistorico, salvarMensagem,
};

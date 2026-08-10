import postgres from 'postgres'

/**
 * Cria/atualiza o papel de aplicação `geracrm_api` em produção.
 *
 * ⚠️ Roda com DATABASE_ADMIN_URL (dono do schema), DEPOIS das migrations —
 * a migration 0001 cria o grupo `geracrm_app`, e este papel de LOGIN só herda
 * dele. É o equivalente de produção do `infra/dev/setup-dev.sql`: o Railway
 * provisiona um Postgres cujo usuário padrão é SUPERUSUÁRIO, e superusuário
 * IGNORA RLS. A API jamais pode conectar com ele — conecta como `geracrm_api`,
 * que é LOGIN, NOBYPASSRLS e NOSUPERUSER. É o núcleo do ADR-001.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
const senha = process.env.GERACRM_API_PASSWORD

if (!adminUrl) throw new Error('DATABASE_ADMIN_URL não definida — bootstrap do papel de app precisa da conexão de dono')
if (!senha) throw new Error('GERACRM_API_PASSWORD não definida — o papel de app precisa de uma senha')

// Literal SQL com aspas simples escapadas (senha não é parametrizável em DDL).
const senhaLiteral = `'${senha.replace(/'/g, "''")}'`

const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })

try {
  // Cria o papel se faltar (idempotente — o deploy roda a cada versão).
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geracrm_api') THEN
        CREATE ROLE geracrm_api LOGIN;
      END IF;
    END
    $$;
  `)

  // Define/rotaciona a senha e trava os poderes perigosos.
  await sql.unsafe(`ALTER ROLE geracrm_api LOGIN PASSWORD ${senhaLiteral} NOBYPASSRLS NOSUPERUSER`)

  // Herda o papel de aplicação criado na migration 0001.
  await sql.unsafe('GRANT geracrm_app TO geracrm_api')

  // Falha ruidosamente se alguém tiver dado poder demais — como no setup-dev.
  const [r] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'geracrm_api'
  `
  if (!r) throw new Error('geracrm_api não foi criado — bootstrap inconsistente')
  if (r.rolsuper || r.rolbypassrls) {
    throw new Error('geracrm_api não pode ser superusuário nem ter BYPASSRLS — o RLS seria ignorado')
  }
  console.log('bootstrap: papel geracrm_api pronto (login, sem superusuário, sem BYPASSRLS)')
} catch (erro) {
  console.error('\n✗ bootstrap do papel de app falhou — o deploy NÃO deve prosseguir\n')
  console.error(erro instanceof Error ? erro.message : erro)
  process.exitCode = 1
} finally {
  await sql.end()
}

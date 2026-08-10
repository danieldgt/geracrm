import postgres from 'postgres'
import { cifrar } from '../contexts/integracao/cofre.js'

/**
 * Seed do tenant + canal de DOGFOODING — para o webhook do PlugZapi resolver
 * numa base recém-migrada (senão `tenant_do_canal()` volta vazio e o webhook
 * responde 404).
 *
 * ⚠️ Só roda com SEED_DOGFOODING=on. NÃO é dado de cliente — é o nosso ambiente
 * de validação. Usa DATABASE_ADMIN_URL (dono): superusuário ignora RLS e pode
 * inserir linhas com `tenant_id` explícito, que é o que um seed precisa.
 *
 * IDs idênticos aos do ambiente local, para o mesmo canal valer nos dois.
 */
if (process.env.SEED_DOGFOODING !== 'on') {
  console.log('seed-dogfooding: desligado (SEED_DOGFOODING != on) — nada a fazer')
  process.exit(0)
}

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_ADMIN_URL não definida — seed precisa da conexão de dono')

const T = '6e7a0d00-0000-4000-8000-000000000001' // tenant
const PLANO = '6e7a0d00-3333-4000-8000-000000000001'
const MODELO = '6e7a0d00-4444-4000-8000-000000000001'
const PV = '6e7a0d00-1111-4000-8000-000000000001' // perfil_vertical
const CANAL = '6e7a0d00-c0c0-4000-8000-000000000001'

const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  await sql`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'dogfooding', 'Dogfooding') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'varejo-dogfooding', 'Varejo') ON CONFLICT DO NOTHING`

  // tenant e perfil_vertical se referenciam — constraints DEFERRED na mesma tx.
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Gera3 (dogfooding)', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })

  await sql`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
            VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WhatsApp PlugZapi (teste)', 'conectado')
            ON CONFLICT DO NOTHING`

  // Credenciais do canal (cifradas) — só quando vêm por env. ⚠️ ENTRAM e nunca
  // saem em claro; é o cofre (CREDENCIAL_CHAVE do ambiente) que cifra.
  const inst = process.env.GERACRM_PLUGZAPI_INSTANCIA
  const tok = process.env.GERACRM_PLUGZAPI_TOKEN
  const clientToken = process.env.GERACRM_PLUGZAPI_CLIENTTOKEN
  if (inst && tok) {
    const cifrado = cifrar({ instancia: inst, token: tok, ...(clientToken ? { clientToken } : {}) })
    await sql`
      UPDATE canal_conectado SET credenciais_cifradas = ${cifrado}, estado = 'conectado'
       WHERE tenant_id = ${T} AND id = ${CANAL}`
    console.log('seed-dogfooding: credenciais do canal PlugZapi gravadas (cifradas)')
  }

  const [c] = await sql<{ tenant_id: string; estado: string }[]>`
    SELECT tenant_id, estado FROM tenant_do_canal(${CANAL}::uuid)`
  if (!c) throw new Error('seed rodou mas tenant_do_canal() não resolve o canal — algo ficou inconsistente')
  console.log(`seed-dogfooding: canal ${CANAL} pronto (tenant ${c.tenant_id}, estado ${c.estado})`)
} catch (erro) {
  console.error('\n✗ seed-dogfooding falhou\n')
  console.error(erro instanceof Error ? erro.message : erro)
  process.exitCode = 1
} finally {
  await sql.end()
}

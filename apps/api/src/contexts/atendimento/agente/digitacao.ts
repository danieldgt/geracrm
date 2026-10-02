import { comTenantServico, type Sql } from '../../../db/index.js'
import { decifrar } from '../../integracao/cofre.js'
import { criarCanal } from '../canais/fabrica.js'
import type { Tarefa } from './fila.js'

/**
 * "Digitando…" antes do turno (ritmo humano, R5) — só onde o canal declara
 * `indicaDigitacao` e o agente está em modo AUTÔNOMO (nos outros modos quem
 * responde é gente, e mostrar o indicador seria prometer resposta do robô).
 *
 * ⚠️ Best-effort por contrato: nunca lança, nunca atrasa o turno. O worker
 * dispara e segue; se a Meta demorar, o indicador chega tarde e some sozinho.
 * O resultado nomeado existe para o teste e para o log, não para decidir nada.
 */
export type DesfechoDigitacao = 'indicou' | 'modo' | 'sem_capacidade' | 'sem_dados' | 'falhou'

export async function indicarDigitacaoDaTarefa(
  tarefa: Pick<Tarefa, 'tenant_id' | 'conversa_id' | 'canal_id' | 'mensagens_ids'>,
  deps: { readonly criar?: typeof criarCanal | undefined } = {},
): Promise<DesfechoDigitacao> {
  try {
    const dados = await comTenantServico(tarefa.tenant_id, async (tx: Sql) => {
      const [l] = await tx<{
        modo: string | null; provedor: string | null; cred: Uint8Array | null; destino: string | null; id_externo: string | null
      }[]>`
        SELECT cfg.modo, cc.provedor, cc.credenciais_cifradas AS cred, ct.e164 AS destino,
               (SELECT m.id_externo FROM mensagem m
                 WHERE m.tenant_id = c.tenant_id AND m.conversa_id = c.id AND m.direcao = 'entrante'
                 ORDER BY m.criado_em DESC LIMIT 1) AS id_externo
          FROM conversa c
          JOIN canal_conectado cc ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
          LEFT JOIN agente_config cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
          LEFT JOIN contato_telefone ct ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.contato_id AND ct.principal
         WHERE c.tenant_id = tenant_atual() AND c.id = ${tarefa.conversa_id}`
      return l ?? null
    })
    if (!dados) return 'sem_dados'
    if (dados.modo !== 'autonomo') return 'modo'
    if (!dados.provedor || !dados.cred || !dados.destino) return 'sem_dados'

    const canal = (deps.criar ?? criarCanal)(dados.provedor, decifrar(Buffer.from(dados.cred)))
    if (!canal.capacidades.indicaDigitacao || !canal.indicarDigitacao) return 'sem_capacidade'
    await canal.indicarDigitacao(dados.destino, dados.id_externo ?? undefined)
    return 'indicou'
  } catch {
    return 'falhou'
  }
}

import { comTenantServico } from '../../../db/index.js'
import type { MidiaExterna } from '../ingestao-mensagem.js'
import { subirMidia } from './armazenamento.js'
import { baixarMidiaDeEntrada, ehReferenciaMeta, type DepsBaixar } from './baixar-entrada.js'

/**
 * Resolve a mídia de ENTRADA do canal OFICIAL: o webhook guardou só o
 * `meta:media:<id>`; aqui baixamos pela Graph API (token do canal) e trocamos
 * pela chave do NOSSO bucket — o irmão de `copiarMidiaEntrante` do não-oficial.
 *
 * ⚠️ PÓS-COMMIT e best-effort: rede não segura transação, e falha aqui não
 * pode virar 500 (a Meta reenviaria o evento em loop). Se falhar, a mensagem
 * mantém o placeholder — a URL da Meta expira em minutos, mas o `media id`
 * continua válido por dias, e o worker de transcrição sabe baixar por ele.
 */
export interface DepsResolverMidia extends DepsBaixar {
  readonly subir?: typeof subirMidia | undefined
}

export async function resolverMidiaMeta(
  tenantId: string, canalId: string, m: MidiaExterna, deps: DepsResolverMidia = {},
): Promise<boolean> {
  if (!ehReferenciaMeta(m.url)) return false
  const baixada = await baixarMidiaDeEntrada(tenantId, canalId, m.url, m.mime, deps)
  if (!baixada) return false

  const chave = await (deps.subir ?? subirMidia)(tenantId, baixada.bytes, baixada.mime)

  // Match por (id, criado_em): criado_em é o valor que NÓS inserimos (recebidaEm).
  // ⚠️ Só troca se ainda estiver no placeholder — reentrega não sobrescreve.
  await comTenantServico(tenantId, async (tx) => {
    await tx`
      UPDATE mensagem
         SET conteudo = conteudo || ${JSON.stringify({ [m.tipo]: chave, mime: baixada.mime })}::text::jsonb
       WHERE tenant_id = tenant_atual() AND id = ${m.mensagemId} AND criado_em = ${m.mensagemCriadoEm}
         AND conteudo->>${m.tipo} = ${m.url}`
  })
  return true
}

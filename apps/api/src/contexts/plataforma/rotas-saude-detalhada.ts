import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { httpDaSaude } from '@geracrm/shared'
import { sql, type Sql } from '../../db/index.js'
import { estadoDoLlm } from '../atendimento/agente/llm-estado.js'
import { transcricaoDoAmbiente } from '../atendimento/midia/transcricao/fabrica.js'
import { embeddingDoAmbiente } from '../catalogo/porta-embedding.js'
import { idadeDoBatimentoSeg } from './batimento.js'
import {
  CACHE_MEDICAO_MS, CONEXOES_SAUDE, lerEmbeddingsComo, lerFilasComo, lerParticoesComo, lerTranscricaoComo, medirSaude, memorizar,
  pingPeloPool, type ConfiguracaoSaude, type DepsSaude,
} from './saude-detalhada.js'

/**
 * GET /saude/detalhada — SAÚDE EM TRÊS ESTADOS (raia P8; playbook da AM §11.1).
 *
 *   {"status":"ok"|"degradado"|"erro","motivos":[...],"componentes":{processo, banco,
 *    workerAgente, filaAgente, llm, transcricao, embeddings, retornos, particoes}}
 *
 * | status    | HTTP | quando                                                              |
 * |-----------|------|---------------------------------------------------------------------|
 * | ok        | 200  | tudo respondendo                                                    |
 * | degradado | 200  | banco fora/lento, worker sem passada, fila atrasada, LLM na reserva… |
 * | erro      | 503  | SÓ o próprio processo encerrando (SIGTERM → `app.close()`)          |
 *
 * ⚠️ Banco fora é `degradado` com 200, não 503: dependência fora nunca derruba
 *    o processo pelo healthcheck. O `/saude` (liveness) e o `/pronto` (readiness
 *    com banco) de `app.ts` NÃO mudam — o healthcheck do Railway segue neles.
 *
 * ⚠️ PÚBLICA e sem token, como o `/saude`: o corpo leva só códigos, contagens e
 *    idades em segundos — nenhum id de tenant, nome de modelo, URL, mensagem de
 *    erro ou segredo. A medição do banco é cacheada (`CACHE_MEDICAO_MS`).
 *
 * MONITOR EXTERNO (UptimeRobot ou equivalente) — por PALAVRA-CHAVE, não só por código HTTP:
 *   URL:      https://<api>/saude/detalhada   (intervalo 5 min)
 *   Tipo:     Keyword — alerta quando a palavra-chave NÃO existe
 *   Palavra:  "status":"ok"
 * Só o topo da resposta tem `status`; os componentes usam `estado`, para que um
 * componente `ok` dentro de uma resposta degradada não engane o monitor. O
 * alerta carrega `motivos` (códigos de `MOTIVOS_SAUDE`); o que fazer em cada um
 * é do runbook (raia P20).
 * ⚠️ Os limiares (`LIMITES_SAUDE_PADRAO`) são PROVISÓRIOS
 * (`LIMITES_SAUDE_PROVISORIOS`) até a calibração com produção na P20.
 *
 * Opções do plugin: só para teste (dependências falsas). `app.ts` registra sem
 * opção nenhuma e tudo vem do ambiente.
 */
export async function rotasSaudeDetalhada(app: FastifyInstance, opts: Partial<DepsSaude> = {}): Promise<void> {
  let encerrando = false
  // preClose roda no início de `app.close()` — que o SIGTERM de `server.ts` chama.
  app.addHook('preClose', async () => { encerrando = true })

  const adminUrl = process.env.DATABASE_ADMIN_URL
  const configuracao: ConfiguracaoSaude = opts.configuracao ?? {
    // Em `server.ts`, os workers só são agendados com DATABASE_ADMIN_URL. A
    // semântica só conta como ligada se, além da chave, houver pgvector — isso
    // é conferido na leitura (`lerEmbeddingsComo` → `sem_pgvector`).
    workers: Boolean(adminUrl),
    transcricao: transcricaoDoAmbiente().capacidades.transcreve,
    embeddingModelo: (() => {
      const porta = embeddingDoAmbiente()
      return porta.capacidades.buscaSemantica ? porta.nome : null
    })(),
  }

  // Pool de serviço PRÓPRIO e preguiçoso: a saúde nunca disputa o pool da API
  // nem as conexões com advisory lock dos workers. Uma conexão por leitura
  // (crítica, áudio, embeddings) — com uma só, a opcional lenta seguraria a crítica.
  let dono: Sql | undefined
  const comDono = <T>(ler: (d: Sql) => () => Promise<T>) => (): Promise<T> => {
    if (!adminUrl) return Promise.reject(new Error('sem_conexao_de_servico'))
    dono ??= postgres(adminUrl, { max: CONEXOES_SAUDE, idle_timeout: 20, connect_timeout: 3, onnotice: () => {} }) as unknown as Sql
    return ler(dono)()
  }
  const agoraReal = () => new Date()
  app.addHook('onClose', async () => {
    if (dono) await (dono as unknown as { end: (o: { timeout: number }) => Promise<void> }).end({ timeout: 2 })
  })

  const deps: DepsSaude = {
    encerrando: opts.encerrando ?? (() => encerrando),
    agora: opts.agora ?? (() => new Date()),
    uptimeSeg: opts.uptimeSeg ?? (() => process.uptime()),
    pingBanco: memorizar(opts.pingBanco ?? pingPeloPool(sql), CACHE_MEDICAO_MS),
    lerFilas: memorizar(opts.lerFilas ?? comDono((d) => lerFilasComo(d, agoraReal)), CACHE_MEDICAO_MS),
    lerTranscricao: memorizar(opts.lerTranscricao ?? comDono((d) => lerTranscricaoComo(d, agoraReal)), CACHE_MEDICAO_MS),
    lerEmbeddings: memorizar(
      opts.lerEmbeddings ?? comDono((d) => lerEmbeddingsComo(d, configuracao.embeddingModelo ?? '')), CACHE_MEDICAO_MS),
    // Muda uma vez por mês: o cache curto basta para a URL pública não virar consulta por chamada.
    lerParticoes: memorizar(opts.lerParticoes ?? comDono((d) => lerParticoesComo(d, agoraReal)), CACHE_MEDICAO_MS),
    idadeBatimento: opts.idadeBatimento ?? ((nome, agora) => idadeDoBatimentoSeg(nome, agora)),
    estadoDoLlm: opts.estadoDoLlm ?? estadoDoLlm,
    configuracao,
    ...(opts.limites ? { limites: opts.limites } : {}),
  }

  app.get('/saude/detalhada', async (_req, reply) => {
    const saude = await medirSaude(deps)
    return reply.code(httpDaSaude(saude.status)).header('cache-control', 'no-store').send(saude)
  })
}

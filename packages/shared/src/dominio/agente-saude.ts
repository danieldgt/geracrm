/**
 * SAÚDE EM TRÊS ESTADOS — `ok | degradado | erro`, com motivos (raia P8,
 * docs/plano-port-playbook-am.md; padrão do playbook da AM §11.1).
 *
 * `avaliarSaude` é PURA: recebe uma fotografia já medida (idades em segundos,
 * contagens) e devolve o veredito. Quem mede (banco, batimento dos workers,
 * estado do LLM) é a API, em `plataforma/saude-detalhada.ts`.
 *
 * Regra que não se negocia:
 *   - `erro` (HTTP 503) só quando o PRÓPRIO processo não atende — encerrando.
 *   - dependência fora (banco, worker parado, fila atrasada, LLM na reserva) é
 *     `degradado` com HTTP 200. Se virasse 503, o healthcheck da plataforma
 *     derrubaria o processo justamente quando ele é o que segura a operação.
 *
 * ⚠️ Os componentes usam `estado`, NÃO `status`: o monitor externo procura a
 *    palavra-chave `"status":"ok"` no corpo, e um componente `ok` dentro de uma
 *    resposta degradada faria o monitor achar a palavra e não alertar.
 *
 * ⚠️ A resposta é PÚBLICA: só contagens, idades em segundos e códigos. Nada de
 *    id de tenant, nome de modelo, URL, mensagem de erro do banco ou segredo.
 *
 * TypeScript puro: consumido pela API, pelo console e pelo app.
 */

export const ESTADOS_SAUDE = ['ok', 'degradado', 'erro'] as const
export type EstadoSaude = (typeof ESTADOS_SAUDE)[number]

/** Códigos curtos e estáveis — o monitor e o runbook (P20) os citam pelo nome. */
export const MOTIVOS_SAUDE = [
  'encerrando',
  'banco_indisponivel',
  'banco_lento',
  'filas_sem_leitura',
  'worker_agente_desligado',
  'worker_agente_parado',
  'fila_agente_acumulada',
  'fila_agente_atrasada',
  'fila_agente_travada',
  'llm_reserva_ativo',
  'modelo_bloqueado',
  'transcricao_parada',
  'transcricao_atrasada',
  'transcricao_sem_leitura',
  'embeddings_parado',
  'embeddings_acumulados',
  'embeddings_sem_leitura',
  'retornos_desligado',
  'retornos_parado',
  'retornos_atrasados',
] as const
export type MotivoSaude = (typeof MOTIVOS_SAUDE)[number]

/** Rótulo em pt-BR de cada motivo, para tela e alerta. */
export const ROTULO_MOTIVO_SAUDE: Readonly<Record<MotivoSaude, string>> = {
  encerrando: 'Processo encerrando',
  banco_indisponivel: 'Banco de dados não respondeu',
  banco_lento: 'Banco de dados respondendo devagar',
  filas_sem_leitura: 'Não foi possível ler as filas',
  worker_agente_desligado: 'Worker do agente desligado nesta instância',
  worker_agente_parado: 'Worker do agente sem passada recente',
  fila_agente_acumulada: 'Fila do agente acumulada',
  fila_agente_atrasada: 'Turno do agente esperando além do prazo',
  fila_agente_travada: 'Turno do agente travado em execução',
  llm_reserva_ativo: 'IA rodando no provedor reserva',
  modelo_bloqueado: 'Modelo de IA bloqueado temporariamente',
  transcricao_parada: 'Worker de transcrição sem passada recente',
  transcricao_atrasada: 'Áudio esperando transcrição além do prazo',
  transcricao_sem_leitura: 'Não foi possível ler os áudios pendentes',
  embeddings_parado: 'Worker de embeddings sem passada recente',
  embeddings_acumulados: 'Muitos itens esperando embedding',
  embeddings_sem_leitura: 'Não foi possível ler os itens sem embedding',
  retornos_desligado: 'Worker de retornos desligado nesta instância',
  retornos_parado: 'Worker de retornos sem passada recente',
  retornos_atrasados: 'Retorno programado vencido sem envio',
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrada (fotografia medida pela API)
// ─────────────────────────────────────────────────────────────────────────────

/** Um worker de intervalo: se está agendado NESTA instância e há quanto tempo deu a última passada. */
export interface EntradaWorker {
  /** false = não agendado neste processo (falta variável de ambiente ou provedor). */
  readonly configurado: boolean
  /** Segundos desde a última passada; null = ainda não bateu. */
  readonly batimentoHaSeg: number | null
}

export interface EntradaSaude {
  readonly encerrando: boolean
  readonly uptimeSeg: number
  /** Latência do `SELECT 1` no pool da API; null = não respondeu. */
  readonly bancoLatenciaMs: number | null
  readonly workers: {
    readonly workerAgente: EntradaWorker
    readonly transcricao: EntradaWorker
    readonly embeddings: EntradaWorker
    readonly retornos: EntradaWorker
  }
  /**
   * Leitura CRÍTICA, de TODOS os tenants (só contagens e idades): fila do
   * agente e retornos. null = não foi possível ler (banco fora, conexão de
   * serviço ausente, teto estourado).
   */
  readonly filas: {
    readonly agente: {
      readonly vencidas: number
      readonly maisAntigaHaSeg: number | null
      /** Tarefas em `executando` e a idade da mais antiga (desde `iniciada_em`). */
      readonly executando: number
      readonly executandoMaisAntigaHaSeg: number | null
    }
    readonly retornos: { readonly vencidos: number; readonly maisAntigoHaSeg: number | null }
  } | null
  /**
   * Leituras OPCIONAIS, independentes da crítica: uma lenta não apaga a outra.
   * null = sem leitura — só vira motivo quando o worker correspondente está
   * configurado; desligado, não há o que contar.
   */
  readonly transcricao: { readonly pendentes: number; readonly maisAntigaHaSeg: number | null } | null
  readonly embeddings: { readonly pendentes: number } | null
  readonly llm: {
    readonly situacao: 'principal' | 'reserva'
    /** Segundos até a reserva expirar; null = no principal. */
    readonly reservaRestanteSeg: number | null
    readonly falhasSeguidas: number
    /** Quantos modelos estão bloqueados agora (o nome não sai na rota pública). */
    readonly modelosBloqueados: number
  }
}

export interface LimitesSaude {
  readonly bancoLentoMs: number
  /** Worker do agente: varre a cada 1 s; uma passada com turnos de IA leva dezenas de segundos. */
  readonly workerAgenteMaxSeg: number
  readonly filaAgenteMaxVencidas: number
  /** Tarefa vencida esperando há mais que isto = o worker não está dando conta. */
  readonly filaAgenteMaxAtrasoSeg: number
  /**
   * Tarefa em `executando` há mais que isto = travada que a recuperação não
   * devolveu. É o `PRAZO_EXECUCAO_MS` da fila (120 s, quando `recuperarTravadas`
   * a devolve) MAIS uma passada longa do worker (120 s) — antes disso, travada
   * é só a recuperação que ainda não rodou.
   */
  readonly filaAgenteTravadaSeg: number
  readonly transcricaoMaxSeg: number
  readonly transcricaoMaxAtrasoSeg: number
  readonly embeddingsMaxSeg: number
  readonly embeddingsMaxPendentes: number
  readonly retornosMaxSeg: number
  readonly retornosMaxAtrasoSeg: number
}

/**
 * ⚠️ PROVISÓRIOS: escolhidos pela cadência de cada worker (`server.ts`) e pelos
 *    números do playbook da AM, ainda NÃO calibrados com produção. Recalibrar
 *    com o histórico real (raia P20) antes de ligar alerta que acorda gente.
 */
export const LIMITES_SAUDE_PROVISORIOS = true as const

export const LIMITES_SAUDE_PADRAO: LimitesSaude = {
  bancoLentoMs: 1_000,
  workerAgenteMaxSeg: 120,
  filaAgenteMaxVencidas: 50,
  filaAgenteMaxAtrasoSeg: 60,
  filaAgenteTravadaSeg: 240,
  transcricaoMaxSeg: 300,
  transcricaoMaxAtrasoSeg: 600,
  embeddingsMaxSeg: 900,
  embeddingsMaxPendentes: 20_000,
  retornosMaxSeg: 300,
  retornosMaxAtrasoSeg: 900,
}

// ─────────────────────────────────────────────────────────────────────────────
// Saída (corpo de GET /saude/detalhada)
// ─────────────────────────────────────────────────────────────────────────────

interface Base {
  readonly estado: EstadoSaude
  readonly motivos: readonly MotivoSaude[]
}

export interface ComponenteWorker extends Base {
  readonly configurado: boolean
  readonly batimentoHaSeg: number | null
  readonly limiteSeg: number
}

export interface SaudeDetalhada {
  /** `erro` só encerrando; o monitor externo procura `"status":"ok"`. */
  readonly status: EstadoSaude
  readonly motivos: readonly MotivoSaude[]
  readonly componentes: {
    readonly processo: Base & { readonly uptimeSeg: number }
    readonly banco: Base & { readonly latenciaMs: number | null; readonly limiteMs: number }
    readonly workerAgente: ComponenteWorker
    readonly filaAgente: Base & {
      readonly vencidas: number | null
      readonly maisAntigaHaSeg: number | null
      readonly executando: number | null
      readonly executandoMaisAntigaHaSeg: number | null
      readonly limiteVencidas: number
      readonly limiteAtrasoSeg: number
      readonly limiteTravadaSeg: number
    }
    readonly llm: Base & {
      readonly situacao: 'principal' | 'reserva'
      readonly reservaRestanteSeg: number | null
      readonly falhasSeguidas: number
      readonly modelosBloqueados: number
    }
    readonly transcricao: ComponenteWorker & {
      readonly pendentes: number | null
      readonly maisAntigaHaSeg: number | null
      readonly limiteAtrasoSeg: number
    }
    readonly embeddings: ComponenteWorker & { readonly pendentes: number | null; readonly limitePendentes: number }
    readonly retornos: ComponenteWorker & {
      readonly vencidos: number | null
      readonly maisAntigoHaSeg: number | null
      readonly limiteAtrasoSeg: number
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Avaliação
// ─────────────────────────────────────────────────────────────────────────────

const base = (motivos: MotivoSaude[]): Base => ({ estado: motivos.length > 0 ? 'degradado' : 'ok', motivos })

/**
 * Batimento de um worker: parado se não bate há mais que `limiteSeg`. Sem
 * batimento ainda, só é parado depois que o processo já viveu `limiteSeg` —
 * deploy recém-subido não acusa worker parado antes da primeira passada.
 */
function worker(
  w: EntradaWorker, limiteSeg: number, uptimeSeg: number,
  m: { desligado: MotivoSaude | null; parado: MotivoSaude },
): { motivos: MotivoSaude[]; campos: Omit<ComponenteWorker, keyof Base> } {
  const motivos: MotivoSaude[] = []
  if (!w.configurado) {
    // Worker obrigatório (agente, retornos) desligado é o produto parado; opcional
    // (transcrição, embeddings) desligado é escolha de configuração — a tela
    // própria já mostra a capacidade ausente (ADR-008).
    if (m.desligado) motivos.push(m.desligado)
  } else {
    const idade = w.batimentoHaSeg ?? uptimeSeg
    if (idade > limiteSeg) motivos.push(m.parado)
  }
  return { motivos, campos: { configurado: w.configurado, batimentoHaSeg: w.batimentoHaSeg, limiteSeg } }
}

/** Avalia a fotografia. Pura: mesma entrada, mesma saída. */
export function avaliarSaude(e: EntradaSaude, lim: LimitesSaude = LIMITES_SAUDE_PADRAO): SaudeDetalhada {
  const semLeitura: MotivoSaude[] = e.filas === null ? ['filas_sem_leitura'] : []

  const motivosProcesso: MotivoSaude[] = e.encerrando ? ['encerrando'] : []
  const processo = {
    estado: (e.encerrando ? 'erro' : 'ok') as EstadoSaude, motivos: motivosProcesso, uptimeSeg: e.uptimeSeg,
  }

  const banco = {
    ...base(e.bancoLatenciaMs === null ? ['banco_indisponivel'] : e.bancoLatenciaMs > lim.bancoLentoMs ? ['banco_lento'] : []),
    latenciaMs: e.bancoLatenciaMs,
    limiteMs: lim.bancoLentoMs,
  }

  const wa = worker(e.workers.workerAgente, lim.workerAgenteMaxSeg, e.uptimeSeg,
    { desligado: 'worker_agente_desligado', parado: 'worker_agente_parado' })
  const workerAgente = { ...base(wa.motivos), ...wa.campos }

  const fa = e.filas?.agente ?? null
  const motivosFila: MotivoSaude[] = [...semLeitura]
  if (fa) {
    if (fa.vencidas > lim.filaAgenteMaxVencidas) motivosFila.push('fila_agente_acumulada')
    if (fa.maisAntigaHaSeg !== null && fa.maisAntigaHaSeg > lim.filaAgenteMaxAtrasoSeg) motivosFila.push('fila_agente_atrasada')
    if (fa.executandoMaisAntigaHaSeg !== null && fa.executandoMaisAntigaHaSeg > lim.filaAgenteTravadaSeg) {
      motivosFila.push('fila_agente_travada')
    }
  }
  const filaAgente = {
    ...base(motivosFila),
    vencidas: fa?.vencidas ?? null,
    maisAntigaHaSeg: fa?.maisAntigaHaSeg ?? null,
    executando: fa?.executando ?? null,
    executandoMaisAntigaHaSeg: fa?.executandoMaisAntigaHaSeg ?? null,
    limiteVencidas: lim.filaAgenteMaxVencidas,
    limiteAtrasoSeg: lim.filaAgenteMaxAtrasoSeg,
    limiteTravadaSeg: lim.filaAgenteTravadaSeg,
  }

  const motivosLlm: MotivoSaude[] = []
  if (e.llm.situacao === 'reserva') motivosLlm.push('llm_reserva_ativo')
  if (e.llm.modelosBloqueados > 0) motivosLlm.push('modelo_bloqueado')
  const llm = { ...base(motivosLlm), ...e.llm }

  const tr = worker(e.workers.transcricao, lim.transcricaoMaxSeg, e.uptimeSeg,
    { desligado: null, parado: 'transcricao_parada' })
  const ft = e.transcricao
  if (e.workers.transcricao.configurado) {
    if (ft === null) tr.motivos.push('transcricao_sem_leitura')
    else if (ft?.maisAntigaHaSeg != null && ft.maisAntigaHaSeg > lim.transcricaoMaxAtrasoSeg) tr.motivos.push('transcricao_atrasada')
  }
  const transcricao = {
    ...base(tr.motivos), ...tr.campos,
    pendentes: e.workers.transcricao.configurado ? (ft?.pendentes ?? null) : null,
    maisAntigaHaSeg: e.workers.transcricao.configurado ? (ft?.maisAntigaHaSeg ?? null) : null,
    limiteAtrasoSeg: lim.transcricaoMaxAtrasoSeg,
  }

  const em = worker(e.workers.embeddings, lim.embeddingsMaxSeg, e.uptimeSeg,
    { desligado: null, parado: 'embeddings_parado' })
  const fe = e.embeddings
  if (e.workers.embeddings.configurado) {
    if (fe === null) em.motivos.push('embeddings_sem_leitura')
    else if (fe && fe.pendentes > lim.embeddingsMaxPendentes) em.motivos.push('embeddings_acumulados')
  }
  const embeddings = {
    ...base(em.motivos), ...em.campos,
    pendentes: e.workers.embeddings.configurado ? (fe?.pendentes ?? null) : null,
    limitePendentes: lim.embeddingsMaxPendentes,
  }

  const re = worker(e.workers.retornos, lim.retornosMaxSeg, e.uptimeSeg,
    { desligado: 'retornos_desligado', parado: 'retornos_parado' })
  const fr = e.filas?.retornos ?? null
  re.motivos.push(...semLeitura)
  if (fr?.maisAntigoHaSeg != null && fr.maisAntigoHaSeg > lim.retornosMaxAtrasoSeg) re.motivos.push('retornos_atrasados')
  const retornos = {
    ...base(re.motivos), ...re.campos,
    vencidos: fr?.vencidos ?? null,
    maisAntigoHaSeg: fr?.maisAntigoHaSeg ?? null,
    limiteAtrasoSeg: lim.retornosMaxAtrasoSeg,
  }

  const componentes = { processo, banco, workerAgente, filaAgente, llm, transcricao, embeddings, retornos }
  const todos: readonly Base[] = Object.values(componentes)
  // Sem repetição: "filas_sem_leitura" aparece em dois componentes, mas é um problema só.
  const motivos = [...new Set(todos.flatMap((c) => c.motivos))]
  const status: EstadoSaude = e.encerrando ? 'erro' : motivos.length > 0 ? 'degradado' : 'ok'
  return { status, motivos, componentes }
}

/** `ok`/`degradado` → 200 (dependência fora não derruba o deploy); `erro` → 503. */
export function httpDaSaude(status: EstadoSaude): 200 | 503 {
  return status === 'erro' ? 503 : 200
}

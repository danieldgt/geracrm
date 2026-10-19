import { describe, it, expect } from 'vitest'
import {
  avaliarSaude, httpDaSaude, LIMITES_SAUDE_PADRAO, LIMITES_SAUDE_PROVISORIOS, MOTIVOS_SAUDE, ROTULO_MOTIVO_SAUDE,
  type EntradaSaude, type MotivoSaude, type EstadoSaude,
} from './agente-saude.js'

const L = LIMITES_SAUDE_PADRAO

/** Fotografia saudável: tudo configurado, batendo e com fila em dia. */
const SAUDAVEL: EntradaSaude = {
  encerrando: false,
  uptimeSeg: 3_600,
  bancoLatenciaMs: 3,
  workers: {
    workerAgente: { configurado: true, batimentoHaSeg: 1 },
    transcricao: { configurado: true, batimentoHaSeg: 5 },
    embeddings: { configurado: true, batimentoHaSeg: 60 },
    retornos: { configurado: true, batimentoHaSeg: 30 },
  },
  filas: {
    agente: { vencidas: 2, maisAntigaHaSeg: 1, executando: 1, executandoMaisAntigaHaSeg: 8 },
    retornos: { vencidos: 0, maisAntigoHaSeg: null },
  },
  transcricao: { pendentes: 1, maisAntigaHaSeg: 10 },
  embeddings: { pendentes: 40 },
  particoes: [{ tabela: 'mensagem', mesesAFrente: 12 }, { tabela: 'venda', mesesAFrente: 24 }],
  llm: { situacao: 'principal', reservaRestanteSeg: null, falhasSeguidas: 0, modelosBloqueados: 0 },
}

type Ajuste = (e: EntradaSaude) => EntradaSaude
const w = (nome: keyof EntradaSaude['workers'], v: EntradaSaude['workers']['workerAgente']): Ajuste =>
  (e) => ({ ...e, workers: { ...e.workers, [nome]: v } })
const filas = (f: Partial<NonNullable<EntradaSaude['filas']>>): Ajuste =>
  (e) => ({ ...e, filas: { ...e.filas!, ...f } })
const agente = (a: Partial<NonNullable<EntradaSaude['filas']>['agente']>): Ajuste =>
  (e) => ({ ...e, filas: { ...e.filas!, agente: { ...e.filas!.agente, ...a } } })

describe('avaliarSaude — tabela de estados', () => {
  const casos: readonly [string, Ajuste, EstadoSaude, readonly MotivoSaude[]][] = [
    ['tudo em dia', (e) => e, 'ok', []],
    ['processo encerrando', (e) => ({ ...e, encerrando: true }), 'erro', ['encerrando']],
    ['banco fora (degradado, nunca erro)', (e) => ({ ...e, bancoLatenciaMs: null, filas: null }), 'degradado',
      ['banco_indisponivel', 'filas_sem_leitura']],
    ['banco lento', (e) => ({ ...e, bancoLatenciaMs: L.bancoLentoMs + 1 }), 'degradado', ['banco_lento']],
    ['banco no limite exato ainda é ok', (e) => ({ ...e, bancoLatenciaMs: L.bancoLentoMs }), 'ok', []],
    ['worker do agente sem passada além do limite', w('workerAgente', { configurado: true, batimentoHaSeg: L.workerAgenteMaxSeg + 1 }),
      'degradado', ['worker_agente_parado']],
    ['worker do agente desligado nesta instância', w('workerAgente', { configurado: false, batimentoHaSeg: null }),
      'degradado', ['worker_agente_desligado']],
    ['fila do agente acumulada', agente({ vencidas: L.filaAgenteMaxVencidas + 1, maisAntigaHaSeg: 5 }),
      'degradado', ['fila_agente_acumulada']],
    ['fila do agente atrasada', agente({ vencidas: 1, maisAntigaHaSeg: L.filaAgenteMaxAtrasoSeg + 1 }),
      'degradado', ['fila_agente_atrasada']],
    ['turno em execução além do prazo + uma passada', agente({ executando: 1, executandoMaisAntigaHaSeg: L.filaAgenteTravadaSeg + 1 }),
      'degradado', ['fila_agente_travada']],
    ['turno passou do prazo mas a recuperação ainda tem uma passada (não é travada)',
      agente({ executando: 1, executandoMaisAntigaHaSeg: 121 }), 'ok', []],
    ['LLM na reserva', (e) => ({ ...e, llm: { ...e.llm, situacao: 'reserva', reservaRestanteSeg: 900, falhasSeguidas: 2 } }),
      'degradado', ['llm_reserva_ativo']],
    ['modelo bloqueado', (e) => ({ ...e, llm: { ...e.llm, modelosBloqueados: 1 } }), 'degradado', ['modelo_bloqueado']],
    ['uma falha de LLM sozinha não degrada', (e) => ({ ...e, llm: { ...e.llm, falhasSeguidas: 1 } }), 'ok', []],
    ['transcrição parada', w('transcricao', { configurado: true, batimentoHaSeg: L.transcricaoMaxSeg + 1 }),
      'degradado', ['transcricao_parada']],
    ['áudio esperando transcrição além do prazo', (e) => ({ ...e, transcricao: { pendentes: 3, maisAntigaHaSeg: L.transcricaoMaxAtrasoSeg + 1 } }),
      'degradado', ['transcricao_atrasada']],
    ['transcrição configurada sem leitura (só ela)', (e) => ({ ...e, transcricao: null }), 'degradado', ['transcricao_sem_leitura']],
    ['transcrição não configurada é ok (capacidade opcional)',
      (e) => w('transcricao', { configurado: false, batimentoHaSeg: null })({ ...e, transcricao: null }), 'ok', []],
    ['embeddings parado', w('embeddings', { configurado: true, batimentoHaSeg: L.embeddingsMaxSeg + 1 }), 'degradado', ['embeddings_parado']],
    ['embeddings acumulados', (e) => ({ ...e, embeddings: { pendentes: L.embeddingsMaxPendentes + 1 } }), 'degradado', ['embeddings_acumulados']],
    ['embeddings configurado sem leitura (só ele)', (e) => ({ ...e, embeddings: null }), 'degradado', ['embeddings_sem_leitura']],
    ['embeddings não configurado é ok (capacidade opcional)',
      (e) => w('embeddings', { configurado: false, batimentoHaSeg: null })({ ...e, embeddings: null }), 'ok', []],
    ['retornos parado', w('retornos', { configurado: true, batimentoHaSeg: L.retornosMaxSeg + 1 }), 'degradado', ['retornos_parado']],
    ['retornos desligado', w('retornos', { configurado: false, batimentoHaSeg: null }), 'degradado', ['retornos_desligado']],
    ['retorno vencido sem envio', filas({ retornos: { vencidos: 4, maisAntigoHaSeg: L.retornosMaxAtrasoSeg + 1 } }),
      'degradado', ['retornos_atrasados']],
    ['partições com 3 meses à frente (no limite) ainda é ok',
      (e) => ({ ...e, particoes: [{ tabela: 'mensagem', mesesAFrente: L.particoesMinMeses }] }), 'ok', []],
    ['partições de UMA tabela com menos de 3 meses à frente (o worker parou)',
      (e) => ({ ...e, particoes: [{ tabela: 'mensagem', mesesAFrente: 12 }, { tabela: 'auditoria', mesesAFrente: L.particoesMinMeses - 1 }] }),
      'degradado', ['particoes_curtas']],
    ['partições sem leitura', (e) => ({ ...e, particoes: null }), 'degradado', ['particoes_sem_leitura']],
    ['encerrando E banco fora: erro manda, motivos somam', (e) => ({ ...e, encerrando: true, bancoLatenciaMs: null }),
      'erro', ['encerrando', 'banco_indisponivel']],
  ]

  it.each(casos)('dado %s, então o estado e os motivos batem', (_nome, ajuste, status, motivos) => {
    const s = avaliarSaude(ajuste(SAUDAVEL))
    expect(s.status).toBe(status)
    expect(s.motivos).toEqual(motivos)
    expect(httpDaSaude(s.status)).toBe(status === 'erro' ? 503 : 200)
  })

  it('dado processo recém-subido sem batimento, então não acusa worker parado antes do limite', () => {
    const recem: EntradaSaude = {
      ...SAUDAVEL,
      uptimeSeg: 10,
      workers: {
        workerAgente: { configurado: true, batimentoHaSeg: null },
        transcricao: { configurado: true, batimentoHaSeg: null },
        embeddings: { configurado: true, batimentoHaSeg: null },
        retornos: { configurado: true, batimentoHaSeg: null },
      },
    }
    expect(avaliarSaude(recem).status).toBe('ok')
    // ...e passa a acusar quando o processo já viveu mais que o limite sem passada nenhuma.
    expect(avaliarSaude({ ...recem, uptimeSeg: L.workerAgenteMaxSeg + 1 }).motivos).toContain('worker_agente_parado')
  })

  it('dado a leitura crítica sem resposta, então o motivo aparece UMA vez e as opcionais seguem valendo', () => {
    const s = avaliarSaude({ ...SAUDAVEL, filas: null })
    expect(s.motivos).toEqual(['filas_sem_leitura'])
    expect(s.componentes.filaAgente.vencidas).toBeNull()
    expect(s.componentes.retornos.vencidos).toBeNull()
    expect(s.componentes.transcricao.estado).toBe('ok')
    expect(s.componentes.embeddings.pendentes).toBe(40)
  })

  it('dado partições curtas, então o componente traz o menor horizonte, o limite e as tabelas (sem tenant)', () => {
    const s = avaliarSaude({ ...SAUDAVEL, particoes: [{ tabela: 'venda', mesesAFrente: 1 }, { tabela: 'mensagem', mesesAFrente: 12 }] })
    expect(s.componentes.particoes).toEqual({
      estado: 'degradado', motivos: ['particoes_curtas'], menorMesesAFrente: 1, limiteMeses: 3,
      tabelas: [{ tabela: 'venda', mesesAFrente: 1 }, { tabela: 'mensagem', mesesAFrente: 12 }],
    })
  })

  it('dado os limites, então estão marcados como provisórios', () => {
    expect(LIMITES_SAUDE_PROVISORIOS).toBe(true)
  })

  it('dado limites próprios, então avalia por eles (limites injetáveis)', () => {
    const s = avaliarSaude(SAUDAVEL, { ...L, filaAgenteMaxVencidas: 1 })
    expect(s.motivos).toEqual(['fila_agente_acumulada'])
  })

  it('dado qualquer estado, então só o topo tem "status" — componentes usam "estado" (monitor por palavra-chave)', () => {
    const degradado = avaliarSaude({ ...SAUDAVEL, bancoLatenciaMs: null })
    expect(JSON.stringify(degradado)).not.toContain('"status":"ok"')
    expect(JSON.stringify(avaliarSaude(SAUDAVEL))).toMatch(/^\{"status":"ok"/)
  })

  it('dado a mesma entrada, então a mesma saída (pura)', () => {
    expect(avaliarSaude(SAUDAVEL)).toEqual(avaliarSaude(SAUDAVEL))
  })

  it('dado cada motivo, então há rótulo em pt-BR', () => {
    for (const m of MOTIVOS_SAUDE) expect(ROTULO_MOTIVO_SAUDE[m].length).toBeGreaterThan(0)
  })
})

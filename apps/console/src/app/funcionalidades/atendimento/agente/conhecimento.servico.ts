import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../../compartilhado/ui/cursor.js'
import { falhaDe, type Pagina } from './agente.servico.js'
import type { ErroApi } from './agente.regras.js'
import type { CapacidadesBusca, TipoArquivo, TipoDocumento } from './conhecimento.regras.js'

/**
 * A porta HTTP da base de conhecimento (`/v1/agente/conhecimento`) — tipos da
 * resposta e chamadas, nada de tela.
 *
 * ⚠️ Falha de negócio volta TIPIFICADA (`{ ok: false, status, erro }`), nunca
 * como exceção solta: 422 traz `campos` para a tela apontar onde corrigir, 409
 * traz `semantica` (por que não dá para embutir), 502 traz `codigo` do
 * fornecedor de embedding. Só as leituras (listar, capacidades) lançam — e aí
 * 403 vira "sem permissão" via `ehSemPermissao`.
 */

export interface Documento {
  readonly id: string
  /** `null` = global (vale para todos os números). */
  readonly canalId: string | null
  readonly titulo: string
  readonly tipo: TipoDocumento
  readonly conteudo: string
  readonly versao: number
  readonly publicado: boolean
  readonly trechos: number
  readonly atualizadoEm: string
  readonly criadoEm: string
}

export interface TrechoBusca {
  readonly texto: string
  readonly documentoId: string
  readonly titulo: string
  readonly tipo: TipoDocumento
  readonly versao: number
  readonly score: number
  readonly fontes: readonly string[]
  /** "Título vN" — como o agente cita. */
  readonly fonte: string
}

export interface ResultadoBusca {
  readonly trechos: readonly TrechoBusca[]
  /** Quais pernas rodaram. */
  readonly fontes: readonly string[]
  /** 'ligada' ou o motivo de a semântica não ter entrado nesta busca. */
  readonly semantica: string
}

export interface ResultadoEmbutir {
  readonly ok: true
  readonly produtos: number
  readonly trechos: number
  readonly restantes: { readonly produtos: number; readonly trechos: number }
}

export interface TextoExtraido {
  readonly texto: string
  readonly caracteres: number
  readonly paginas: number | null
  readonly avisos: readonly string[]
}

/** O corpo de erro desta área: além de `erro/mensagem/campos`, o 409 e o 502 trazem detalhe próprio. */
export interface ErroConhecimento extends ErroApi {
  readonly semantica?: string
  readonly codigo?: string
  /** 404 `versao_anterior_ao_historico`: onde o histórico do documento começa. */
  readonly primeiraRegistrada?: number
}
export type FalhaConhecimento = { readonly ok: false; readonly status: number; readonly erro: ErroConhecimento }
export type Resultado<T> = ({ readonly ok: true } & T) | FalhaConhecimento

/** Uma versão do histórico (P9) — sem o texto; o texto vem em `lerVersao`. */
export interface VersaoItem {
  readonly versao: number
  readonly titulo: string
  readonly tipo: string
  readonly canalId: string | null
  readonly caracteres: number
  /** criacao | edicao | restauracao | sincronismo | backfill | automatica (valor novo sai cru). */
  readonly origem: string
  readonly restauradaDe: number | null
  readonly observacao: string | null
  readonly autor: { readonly id: string; readonly nome: string | null } | null
  readonly autorStaff: boolean
  readonly criadoEm: string
  readonly atual: boolean
}

export interface VersaoCompleta extends VersaoItem {
  readonly documentoId: string
  readonly conteudo: string
  readonly versaoAtual: number
}

export interface PaginaVersoes {
  readonly versaoAtual: number
  readonly itens: readonly VersaoItem[]
  readonly proximoCursor: string | null
}

export interface CorpoDocumento {
  readonly titulo: string
  readonly tipo: TipoDocumento
  readonly conteudo: string
  readonly canalId: string | null
}

@Injectable({ providedIn: 'root' })
export class ConhecimentoServico {
  private readonly http = inject(HttpClient)

  /** Com `canalId`, vêm os globais e os desse número. Lança em falha (403 → sem permissão). */
  listar(p: { readonly cursor: string | null; readonly canalId: string; readonly incluirDespublicados: boolean }): Promise<Pagina<Documento>> {
    const q = queryDeLista({
      cursor: p.cursor, canalId: p.canalId || null, incluirDespublicados: p.incluirDespublicados ? 'true' : null,
    })
    return firstValueFrom(this.http.get<Pagina<Documento>>(`/v1/agente/conhecimento${q}`))
  }

  async criar(corpo: CorpoDocumento): Promise<Resultado<{ documento: Documento }>> {
    try {
      const d = await firstValueFrom(this.http.post<Documento>('/v1/agente/conhecimento', corpo))
      return { ok: true, documento: d }
    } catch (e) { return falha(e) }
  }

  /** Histórico do documento, por cursor (número da versão). Lança em falha (403 → sem permissão). */
  listarVersoes(id: string, cursor: string | null): Promise<PaginaVersoes> {
    return firstValueFrom(this.http.get<PaginaVersoes>(`/v1/agente/conhecimento/${id}/versoes${queryDeLista({ cursor })}`))
  }

  /** O texto exato da versão. Falha tipificada: 404 nomeia "anterior ao histórico" × "não existe". */
  async lerVersao(id: string, versao: number): Promise<Resultado<{ versao: VersaoCompleta }>> {
    try {
      const v = await firstValueFrom(this.http.get<VersaoCompleta>(`/v1/agente/conhecimento/${id}/versoes/${versao}`))
      return { ok: true, versao: v }
    } catch (e) { return falha(e) }
  }

  /** Restaurar = versão NOVA com o texto da escolhida; o histórico não muda. */
  async restaurar(id: string, versao: number, observacao: string): Promise<Resultado<{ documento: Documento }>> {
    try {
      const d = await firstValueFrom(this.http.post<Documento>(
        `/v1/agente/conhecimento/${id}/restaurar`, observacao ? { versao, observacao } : { versao }))
      return { ok: true, documento: d }
    } catch (e) { return falha(e) }
  }

  async editar(id: string, corpo: Partial<CorpoDocumento> & { readonly publicado?: boolean; readonly observacao?: string }): Promise<Resultado<{ documento: Documento }>> {
    try {
      const d = await firstValueFrom(this.http.patch<Documento>(`/v1/agente/conhecimento/${id}`, corpo))
      return { ok: true, documento: d }
    } catch (e) { return falha(e) }
  }

  /** Despublica — sai do retrieval, o texto fica guardado. Não apaga. */
  async despublicar(id: string): Promise<Resultado<Record<never, never>>> {
    try {
      await firstValueFrom(this.http.delete<{ ok: true }>(`/v1/agente/conhecimento/${id}`))
      return { ok: true }
    } catch (e) { return falha(e) }
  }

  async buscar(pergunta: string, canalId: string): Promise<Resultado<{ resultado: ResultadoBusca }>> {
    try {
      const r = await firstValueFrom(this.http.post<ResultadoBusca>(
        '/v1/agente/conhecimento/buscar', canalId ? { pergunta, canalId } : { pergunta }))
      return { ok: true, resultado: r }
    } catch (e) { return falha(e) }
  }

  /** O que a busca consegue NESTE servidor. É do tenant inteiro, não do número. Lança em falha. */
  capacidades(): Promise<CapacidadesBusca> {
    return firstValueFrom(this.http.get<CapacidadesBusca>('/v1/agente/conhecimento/capacidades'))
  }

  /** "Embutir agora": alguns lotes deste tenant; o worker segue o resto. */
  async embutir(): Promise<Resultado<{ resultado: ResultadoEmbutir }>> {
    try {
      const r = await firstValueFrom(this.http.post<ResultadoEmbutir>('/v1/agente/conhecimento/embutir', {}))
      return { ok: true, resultado: r }
    } catch (e) { return falha(e) }
  }

  /** Devolve o TEXTO do arquivo para revisão — nunca cria o documento. */
  async extrair(p: { readonly nome: string; readonly tipo: TipoArquivo; readonly conteudoBase64: string }): Promise<Resultado<{ texto: TextoExtraido }>> {
    try {
      const r = await firstValueFrom(this.http.post<TextoExtraido>('/v1/agente/conhecimento/extrair', p))
      return { ok: true, texto: r }
    } catch (e) { return falha(e) }
  }
}

/** O mesmo tradutor do agente; o corpo já vem inteiro, só o tipo fica mais largo (semantica/codigo). */
function falha(e: unknown): FalhaConhecimento {
  const f = falhaDe(e)
  return { ok: false, status: f.status, erro: f.erro as ErroConhecimento }
}

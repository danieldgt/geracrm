import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { EsquemaCredencial } from '../integracao/tipos.js'
import { classificarFalhaDeCarga, corpoDaApi, type FalhaDeCarga } from './canais.regras.js'

export interface ProvedorCanal {
  readonly codigo: string
  readonly nome: string
  readonly tipo: string
  readonly oficial: boolean
  readonly descricao: string
  readonly esquemaCredencial: EsquemaCredencial
  readonly capacidades: { janela24h: boolean; aceitaTemplate: boolean; riscoBanimento: boolean; textoLivreSempre: boolean }
  readonly aviso: string | null
}

export interface Canal {
  readonly id: string
  readonly tipo: string
  readonly provedor: string | null
  readonly nomeAmigavel: string
  readonly estado: string
  readonly ultimoErro: string | null
  /** ⚠️ Quando o estado foi OBSERVADO (0069). `null` = nunca verificado. */
  readonly verificadoEm?: string | null
  /** Pausa de DISPARO (manual ou automática por queda de entrega). */
  readonly disparoPausado?: boolean
  readonly pausadoMotivo?: string | null
  readonly credencial: { configurada: boolean; camposPreenchidos: readonly string[] }
  /** ⚠️ Decidido no servidor (só admin, só não-oficial). A garantia é o 403 do QR. */
  readonly podeParear?: boolean
  /** Modo EFETIVO agora (teto da conta, número e recorte de horário). */
  readonly modoAgente?: string
  /** Modo configurado no número. */
  readonly modoAgenteNumero?: string
  /** Quem restringiu: 'numero' (ninguém), 'tenant' (teto da conta) ou 'recorte'. */
  readonly modoAgenteOrigem?: 'numero' | 'tenant' | 'recorte'
  readonly modoAgenteMotivo?: string | null
  /** Ativas suspensas (P11/0101). `null` = não suspensas ou coluna ainda ausente. */
  readonly ativasSuspensas?: { desde: string; motivo: string | null } | null
  /** Já MASCARADOS pela API — o valor completo nunca chega ao console. */
  readonly telefoneMascarado?: string | null
  readonly identificadorMascarado?: string | null
}

/** A tela usa o `podeParear` POR número; o do topo da resposta serve a outros clientes. */
interface ListaCanais {
  readonly itens: Canal[]
}

export interface ErroApi {
  readonly erro: string
  readonly mensagem: string
  readonly detalhe?: { campos?: Record<string, string>; campo?: string }
}

export type EstadoLista = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao' | 'servidor_indisponivel'

/** Saúde da frota (EP-03): entrega recente + alertas abertos. */
export interface SaudeFrota {
  readonly entrega: { ok: number; falha: number; taxa: number | null; amostras: number }
  readonly alertasAbertos: number
}

@Injectable({ providedIn: 'root' })
export class CanaisServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoLista>('ocioso')
  readonly canais = signal<readonly Canal[]>([])
  readonly provedores = signal<readonly ProvedorCanal[]>([])
  readonly erro = signal<string | null>(null)
  readonly testando = signal<ReadonlySet<string>>(new Set())
  readonly saude = signal<SaudeFrota | null>(null)
  readonly vazio = computed(() => this.estado() === 'pronto' && this.canais().length === 0)
  /**
   * ⚠️ Servidor fora DURANTE o polling, com a frota já na tela: a lista fica
   * (é a última leitura) e a tela avisa desde quando não há notícia. Trocar a
   * lista por "erro" apagaria o que a pessoa já sabia; não avisar faria o
   * estado de 5 min atrás passar por atual.
   */
  readonly indisponivelDesde = signal<Date | null>(null)
  /** Falha de outro tipo no polling (ex.: 500 da API): avisa, mantendo a lista. */
  readonly erroAtualizacao = signal<string | null>(null)
  /** Falhas seguidas de leitura — o polling recua com elas (3→6→12→30 s). */
  readonly falhasSeguidas = signal(0)

  async carregar(): Promise<void> {
    // ⚠️ Esqueleto só com a lista VAZIA e sem aviso de servidor fora na tela:
    //    a nova tentativa não troca o que a pessoa vê por um esqueleto que pisca.
    if (this.canais().length === 0 && this.estado() !== 'servidor_indisponivel') this.estado.set('carregando')
    this.erro.set(null)
    try {
      const [provs, lista, saude] = await Promise.all([
        firstValueFrom(this.http.get<ProvedorCanal[]>('/v1/canais/provedores')),
        firstValueFrom(this.http.get<ListaCanais>('/v1/canais')),
        // ⚠️ Saúde é PARCIAL: se falhar, os canais ainda aparecem (não derruba a tela).
        firstValueFrom(this.http.get<SaudeFrota>('/v1/frota/saude')).catch(() => null),
      ])
      this.provedores.set(provs)
      this.#aplicarLista(lista)
      this.saude.set(saude)
      this.estado.set('pronto')
    } catch (e) {
      const falha = falhaDe(e)
      if (falha === 'sem_permissao') { this.estado.set('sem_permissao'); return }
      this.falhasSeguidas.update((n) => n + 1)
      if (falha === 'servidor_indisponivel') {
        this.indisponivelDesde.update((d) => d ?? new Date())
        this.estado.set('servidor_indisponivel')
        return
      }
      this.erro.set('Não foi possível carregar os canais.')
      this.estado.set('erro')
    }
  }

  /**
   * Releitura SILENCIOSA da frota (polling e pós-teste): sem esqueleto, sem
   * apagar a lista. ⚠️ Se a carga inicial ainda não deu certo, cai na carga
   * completa — é o que tira a tela de "servidor indisponível" quando ele volta.
   */
  async atualizar(): Promise<void> {
    if (this.estado() !== 'pronto') { await this.carregar(); return }
    try {
      const lista = await firstValueFrom(this.http.get<ListaCanais>('/v1/canais'))
      this.#aplicarLista(lista)
    } catch (e) {
      const falha = falhaDe(e)
      // Papel retirado durante a sessão: a tela deixa de mostrar a frota.
      if (falha === 'sem_permissao') { this.estado.set('sem_permissao'); return }
      // Qualquer outra falha no polling: mantém a última leitura e AVISA —
      // com o nome certo: servidor fora × erro da API.
      this.falhasSeguidas.update((n) => n + 1)
      if (falha === 'servidor_indisponivel') this.indisponivelDesde.update((d) => d ?? new Date())
      else this.erroAtualizacao.set('Erro ao atualizar a frota. Os estados abaixo são da última leitura.')
    }
  }

  #aplicarLista(lista: ListaCanais): void {
    this.canais.set(lista.itens)
    this.indisponivelDesde.set(null)
    this.erroAtualizacao.set(null)
    this.falhasSeguidas.set(0)
  }

  async criar(dados: { provedor: string; nomeAmigavel: string; credencial: Record<string, string> }):
    Promise<{ ok: true; id: string } | { ok: false; erro: ErroApi }> {
    try {
      const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/canais', dados))
      await this.carregar()
      return { ok: true, id: r.id }
    } catch (e) {
      return { ok: false, erro: erroApiDe(e) }
    }
  }

  /**
   * Editar nome e/ou credencial.
   *
   * ⚠️ Campo de credencial em branco NÃO é apagar: o servidor mescla com o que
   * já está guardado. É o que permite corrigir só o token errado sem redigitar
   * (nem ter à mão) os outros — que é como o canal quebrado costuma chegar aqui.
   */
  async editar(id: string, dados: { nomeAmigavel?: string; credencial?: Record<string, string> }):
    Promise<{ ok: true; credencialTrocada: boolean } | { ok: false; erro: ErroApi }> {
    try {
      const r = await firstValueFrom(
        this.http.put<{ credencialTrocada: boolean }>(`/v1/canais/${id}`, dados))
      await this.carregar()
      return { ok: true, credencialTrocada: r.credencialTrocada }
    } catch (e) {
      return { ok: false, erro: erroApiDe(e) }
    }
  }

  /**
   * Tirar o número da frota.
   *
   * ⚠️ Dois desfechos, decididos pelo servidor: número que nunca conversou é
   * REMOVIDO; número com histórico é ARQUIVADO (some da tela, conversas
   * preservadas). A tela precisa dizer qual dos dois aconteceu — são promessas
   * diferentes para quem clicou.
   */
  async remover(id: string):
    Promise<{ ok: true; estado: 'removido' | 'arquivado'; conversas: number } | { ok: false; erro: ErroApi }> {
    try {
      const r = await firstValueFrom(
        this.http.delete<{ estado: 'removido' | 'arquivado'; conversas: number }>(`/v1/canais/${id}`))
      await this.carregar()
      return { ok: true, estado: r.estado, conversas: r.conversas }
    } catch (e) {
      return { ok: false, erro: erroApiDe(e) }
    }
  }

  async testar(id: string): Promise<{ conectado: boolean; detalhe?: string }> {
    this.testando.update((s) => new Set(s).add(id))
    try {
      const r = await firstValueFrom(this.http.post<{ conectado: boolean; detalhe?: string }>(`/v1/canais/${id}/testar`, {}))
      // ⚠️ Silencioso: o pareamento testa a cada 3 s, e recarregar com
      //    esqueleto fazia a lista inteira piscar durante a leitura do QR.
      await this.atualizar()
      return r
    } catch {
      return { conectado: false, detalhe: 'falha ao testar' }
    } finally {
      this.testando.update((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // Aquecimento de frota (Onda 3): teto diário de disparo por número.
  readonly aquecimento = signal<Record<string, Aquecimento>>({})
  /** Falha de aquecimento por canal — a tela mostra ao lado do botão, nunca some. */
  readonly erroAquecimento = signal<Record<string, string>>({})

  async carregarAquecimento(id: string): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<Aquecimento>(`/v1/canais/${id}/aquecimento`))
      this.aquecimento.update((a) => ({ ...a, [id]: r }))
      this.erroAquecimento.update((m) => { const n = { ...m }; delete n[id]; return n })
    } catch (e) {
      // Parcial: o canal continua na lista; só o aquecimento não veio.
      this.erroAquecimento.update((m) => ({ ...m, [id]: erroApiDe(e).mensagem ?? 'Não foi possível ler o aquecimento.' }))
    }
  }

  async iniciarAquecimento(id: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/canais/${id}/aquecimento`, {}))
      await this.carregarAquecimento(id)
    } catch (e) {
      this.erroAquecimento.update((m) => ({ ...m, [id]: erroApiDe(e).mensagem ?? 'Não foi possível iniciar o aquecimento.' }))
    }
  }
}

export interface Aquecimento {
  readonly emAquecimento: boolean
  readonly dia: number
  readonly limiteHoje: number | null
  readonly usadoHoje: number
  readonly restante: number | null
}

/** Classifica a falha HTTP — regra pura em `canais.regras.ts`. */
function falhaDe(e: unknown): FalhaDeCarga {
  // ⚠️ Exceção que não é HTTP é defeito NOSSO (código), não servidor fora.
  if (!(e instanceof HttpErrorResponse)) return 'erro'
  return classificarFalhaDeCarga(e.status, corpoDaApi(e.error))
}

function erroApiDe(e: unknown): ErroApi {
  if (e instanceof HttpErrorResponse && e.error && typeof e.error === 'object' && 'erro' in e.error) return e.error as ErroApi
  return { erro: 'erro.desconhecido', mensagem: 'Erro inesperado.' }
}

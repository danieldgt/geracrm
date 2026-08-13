import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { TipoCanal } from '@geracrm/shared'

/** Estado da janela de 24h — vem do domínio (calcularJanela), não daqui. */
export interface Janela {
  readonly estado: 'aberta' | 'terminando' | 'fechada'
  readonly expiraEm: string | null
  readonly restanteMs: number
}

export interface ItemConversa {
  readonly id: string
  readonly contatoId: string
  readonly nome: string
  readonly conduzidaPor: string
  readonly ultimaMensagemEm: string | null
  readonly ultimaDirecao: string | null
  readonly ultimaMensagem: { readonly texto: string; readonly direcao: string | null } | null
  readonly naoLida: boolean
  /** Tipo de canal — a lista pinta o símbolo da marca por conversa (multicanal). */
  readonly canalTipo: TipoCanal
  readonly janela: Janela
}

export interface Mensagem {
  readonly id: string
  readonly direcao: 'entrante' | 'saliente'
  readonly tipo: string
  readonly conteudo: unknown
  readonly status: string | null
  readonly criadoEm: string
  readonly apagada?: boolean
  readonly apagadaParaTodos?: boolean
  readonly editada?: boolean
}

export interface Thread {
  readonly id: string
  readonly nome: string
  readonly contatoId: string
  readonly conduzidaPor: string
  /** ⚠️ Janela de 24h + template só valem no WhatsApp Oficial (Meta). */
  readonly exigeJanela24h: boolean
  /** Tipo de canal — o cabeçalho pinta o símbolo da marca (multicanal). */
  readonly canalTipo: TipoCanal
  /** Atendimento aberto (EP-06): null = ninguém assumiu. */
  readonly atendimento: {
    readonly estado: string
    readonly atendenteNome: string | null
    readonly protocolo: number | null
  } | null
  readonly temMaisAntigas: boolean
  readonly janela: Janela
  readonly mensagens: readonly Mensagem[]
}

export type EstadoLista = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
export type EstadoThread = 'nenhuma' | 'carregando' | 'pronto' | 'erro'

@Injectable({ providedIn: 'root' })
export class InboxServico {
  private readonly http = inject(HttpClient)

  // Lista
  readonly estado = signal<EstadoLista>('ocioso')
  readonly conversas = signal<readonly ItemConversa[]>([])
  readonly erro = signal<string | null>(null)

  // Abas (E6-02): todas / fila (não assumidas) / meus (em atendimento).
  readonly filtro = signal<'todas' | 'fila' | 'meus'>('todas')
  readonly contadores = signal<{ fila: number; meus: number }>({ fila: 0, meus: 0 })

  private urlLista(): string {
    const f = this.filtro()
    return `/v1/conversas?limite=40${f !== 'todas' ? `&filtro=${f}` : ''}`
  }
  readonly avisoBusca = signal<string | null>(null)
  /** Abre a conversa de um protocolo (E5-08). */
  async abrirPorProtocolo(n: number): Promise<void> {
    this.avisoBusca.set(null)
    try {
      const r = await firstValueFrom(this.http.get<{ conversaId: string }>(`/v1/conversas/por-protocolo?p=${n}`))
      await this.abrir(r.conversaId)
    } catch {
      this.avisoBusca.set('Protocolo não encontrado.')
    }
  }

  async trocarFiltro(f: 'todas' | 'fila' | 'meus'): Promise<void> {
    if (this.filtro() === f) return
    this.filtro.set(f)
    await this.carregar()
  }
  async carregarContadores(): Promise<void> {
    try {
      const c = await firstValueFrom(this.http.get<{ fila: number; meus: number }>('/v1/fila/contadores'))
      this.contadores.set(c)
    } catch {
      // silencioso
    }
  }
  readonly vazio = computed(() => this.estado() === 'pronto' && this.conversas().length === 0)

  // Rail do chat (contraível), ancorado À DIREITA. O chat é a funcionalidade
  // principal e vive SEMPRE montado na casca: recolhido = faixa de avatares;
  // expandido = inbox completo. Estado no serviço p/ sobreviver à navegação.
  //
  // ⚠️ Dois eixos configuráveis pelo usuário, PERSISTIDOS:
  //  · sobrepor: expandido EMPURRA o conteúdo (false) ou SOBREPÕE em overlay (true);
  //  · largura: quantos px o painel ocupa (o usuário arrasta a borda).
  private static readonly LARG_MIN = 300
  private static readonly LARG_MAX = 900
  readonly railAberto = signal(false)
  readonly railSobrepor = signal(localStorage.getItem('geracrm.rail.sobrepor') === '1')
  readonly railLargura = signal(this.larguraSalva())
  readonly naoLidasTotal = computed(() => this.conversas().filter((c) => c.naoLida).length)

  private larguraSalva(): number {
    const n = Number(localStorage.getItem('geracrm.rail.largura'))
    return Number.isFinite(n) && n > 0
      ? Math.min(InboxServico.LARG_MAX, Math.max(InboxServico.LARG_MIN, n))
      : 440
  }

  abrirRail(): void { this.railAberto.set(true) }
  fecharRail(): void { this.railAberto.set(false); this.pararPresenca() }
  alternarRail(): void { this.railAberto() ? this.fecharRail() : this.abrirRail() }
  alternarSobrepor(): void {
    const v = !this.railSobrepor()
    this.railSobrepor.set(v)
    localStorage.setItem('geracrm.rail.sobrepor', v ? '1' : '0')
  }
  /** Redimensiona (arrastar a borda); grava a proporção escolhida. */
  definirLargura(px: number): void {
    const v = Math.min(InboxServico.LARG_MAX, Math.max(InboxServico.LARG_MIN, Math.round(px)))
    this.railLargura.set(v)
    localStorage.setItem('geracrm.rail.largura', String(v))
  }

  // Thread selecionada
  readonly estadoThread = signal<EstadoThread>('nenhuma')
  readonly thread = signal<Thread | null>(null)
  readonly selecionadaId = signal<string | null>(null)

  // Composer (envio)
  readonly rascunho = signal('')
  readonly enviando = signal(false)
  readonly erroEnvio = signal<string | null>(null)

  // Presença (INB-18): quem MAIS está nesta conversa agora.
  readonly presentes = signal<readonly string[]>([])
  private presencaTimer: ReturnType<typeof setInterval> | null = null
  /** Heartbeat a cada 15s; o servidor considera presente quem bateu nos últimos 40s. */
  private static readonly HEARTBEAT_MS = 15_000

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: ItemConversa[] }>(this.urlLista()),
      )
      this.conversas.set(r.itens)
      this.estado.set('pronto')
      void this.carregarContadores()
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erro.set(e instanceof HttpErrorResponse && e.status === 0
        ? 'Sem conexão com o Drezz Hub.' : 'Não foi possível carregar as conversas.')
      this.estado.set('erro')
    }
  }

  async abrir(id: string): Promise<void> {
    // Abrir uma conversa expande o rail — vale para o strip, o sino, "conversar"
    // do contato e o enviar-resumo do pedido (todos chamam abrir()).
    this.railAberto.set(true)
    // Sai da anterior antes de entrar na nova (some na hora para os colegas).
    this.pararPresenca()
    this.selecionadaId.set(id)
    this.estadoThread.set('carregando')
    this.thread.set(null)
    try {
      const t = await firstValueFrom(this.http.get<Thread>(`/v1/conversas/${id}`))
      this.thread.set(t)
      this.estadoThread.set('pronto')
      // Marca lida (E5-12) e atualiza a lista para o badge de não-lido sumir.
      void this.marcarLida(id)
      this.iniciarPresenca(id)
    } catch {
      this.estadoThread.set('erro')
    }
  }

  /**
   * Presença (INB-18): bate o coração enquanto a conversa está aberta. ⚠️ NÃO é
   * polling de fundo — só roda com a conversa aberta, e a MESMA resposta traz
   * quem mais está ali. Ao trocar de conversa ou fechar, `pararPresenca` some.
   */
  private iniciarPresenca(id: string): void {
    void this.baterPresenca(id)
    this.presencaTimer = setInterval(() => void this.baterPresenca(id), InboxServico.HEARTBEAT_MS)
  }

  private async baterPresenca(id: string): Promise<void> {
    // Se já troquei de conversa, ignoro a resposta atrasada.
    if (this.selecionadaId() !== id) return
    try {
      const r = await firstValueFrom(
        this.http.post<{ outros: { nome: string }[] }>(`/v1/conversas/${id}/presenca`, {}),
      )
      if (this.selecionadaId() === id) this.presentes.set(r.outros.map((o) => o.nome))
    } catch {
      // Silencioso: presença é um aviso, não pode estragar a tela.
    }
  }

  /** Encerra o heartbeat e avisa o servidor que saí (sem esperar o TTL). */
  pararPresenca(): void {
    if (this.presencaTimer) { clearInterval(this.presencaTimer); this.presencaTimer = null }
    const anterior = this.selecionadaId()
    this.presentes.set([])
    if (anterior) {
      // Melhor esforço: se falhar, o TTL do servidor cobre.
      this.http.delete(`/v1/conversas/${anterior}/presenca`).subscribe({ error: () => {} })
    }
  }

  readonly carregandoAnteriores = signal(false)
  /** Carrega mensagens ANTERIORES (E5-09) e prepende, sem perder o que já há. */
  async carregarAnteriores(): Promise<void> {
    const t = this.thread()
    if (!t || !t.temMaisAntigas || this.carregandoAnteriores() || t.mensagens.length === 0) return
    const primeira = t.mensagens[0]!
    this.carregandoAnteriores.set(true)
    try {
      const url = `/v1/conversas/${t.id}/mensagens?anteriorEm=${encodeURIComponent(primeira.criadoEm)}&anteriorId=${primeira.id}`
      const r = await firstValueFrom(this.http.get<{ mensagens: Mensagem[]; temMaisAntigas: boolean }>(url))
      this.thread.set({ ...t, mensagens: [...r.mensagens, ...t.mensagens], temMaisAntigas: r.temMaisAntigas })
    } catch {
      // silencioso
    } finally {
      this.carregandoAnteriores.set(false)
    }
  }

  /** Marca a conversa lida até a versão atual (para este usuário). */
  private async marcarLida(id: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/conversas/${id}/lida`, {}))
      await this.atualizar()
    } catch {
      // silencioso — o badge some no próximo refresh.
    }
  }

  /**
   * Refresh SILENCIOSO da lista — para o tempo real. ⚠️ NÃO volta ao estado
   * 'carregando' (nada de esqueleto piscando a cada mensagem que chega); só
   * troca os dados. Se estava vazio, acende a lista.
   */
  async atualizar(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: ItemConversa[] }>(this.urlLista()),
      )
      this.conversas.set(r.itens)
      if (this.estado() !== 'pronto') this.estado.set('pronto')
      void this.carregarContadores()
    } catch {
      // Silencioso: uma atualização que falha não estraga a tela; o próximo
      // evento (ou a reconexão) tenta de novo.
    }
  }

  /** Envia uma imagem (data URL base64) com legenda opcional. */
  async enviarImagem(conversaId: string, imagem: string, legenda?: string): Promise<void> {
    if (this.enviando()) return
    this.enviando.set(true)
    this.erroEnvio.set(null)
    try {
      await firstValueFrom(
        this.http.post(`/v1/conversas/${conversaId}/mensagens`, { tipo: 'imagem', imagem, ...(legenda ? { legenda } : {}) }),
      )
      this.rascunho.set('')
      await this.atualizarThread(conversaId)
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string; motivo?: string } | null) : null
      this.erroEnvio.set(corpo?.mensagem ?? corpo?.motivo ?? 'Não foi possível enviar a imagem.')
    } finally {
      this.enviando.set(false)
    }
  }

  /** Envia um áudio (data URL base64) — vira mensagem de voz. */
  async enviarAudio(conversaId: string, audio: string): Promise<void> {
    if (this.enviando()) return
    this.enviando.set(true)
    this.erroEnvio.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/conversas/${conversaId}/mensagens`, { tipo: 'audio', audio }))
      await this.atualizarThread(conversaId)
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string; motivo?: string } | null) : null
      this.erroEnvio.set(corpo?.mensagem ?? corpo?.motivo ?? 'Não foi possível enviar o áudio.')
    } finally {
      this.enviando.set(false)
    }
  }

  /** Assume o atendimento da conversa (EP-06). Vencedor atômico no servidor. */
  async assumir(conversaId: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/conversas/${conversaId}/assumir`, {}))
      await this.atualizarThread(conversaId)
    } catch (e) {
      const c = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string } | null) : null
      this.erroEnvio.set(c?.mensagem ?? 'Não foi possível assumir o atendimento.')
      // Alguém assumiu antes: reflete o estado real na hora.
      await this.atualizarThread(conversaId)
    }
  }

  /** Cria um card de AÇÃO no chat (pedido/orçamento…). */
  async criarAcao(
    conversaId: string,
    entrada: { acao: string; titulo: string; resumo?: string; dados?: Record<string, unknown>; opcoes: { id: string; rotulo: string }[] },
  ): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/conversas/${conversaId}/acoes`, { dados: {}, ...entrada }))
      await this.atualizarThread(conversaId)
    } catch (e) {
      const c = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string } | null) : null
      this.erroEnvio.set(c?.mensagem ?? 'Não foi possível criar a ação.')
    }
  }

  /** Resolve um card de ação (o usuário escolheu uma opção). */
  async resolverAcao(conversaId: string, mid: string, opcaoId: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/mensagens/${mid}/resolver`, { opcaoId }))
      await this.atualizarThread(conversaId)
    } catch (e) {
      const c = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string } | null) : null
      this.erroEnvio.set(c?.mensagem ?? 'Não foi possível resolver a ação.')
    }
  }

  /** Apaga uma mensagem (para todos = recall no WhatsApp; senão só na tela). */
  async apagarMensagem(conversaId: string, mid: string, paraTodos: boolean): Promise<void> {
    await firstValueFrom(this.http.delete(`/v1/conversas/${conversaId}/mensagens/${mid}`, { body: { paraTodos } }))
    await this.atualizarThread(conversaId)
  }

  /** Edita o texto de uma mensagem enviada (como o WhatsApp). */
  async editarMensagem(conversaId: string, mid: string, texto: string): Promise<void> {
    await firstValueFrom(this.http.patch(`/v1/conversas/${conversaId}/mensagens/${mid}`, { texto }))
    await this.atualizarThread(conversaId)
  }

  /** Refresh silencioso da thread aberta, se for a conversa que mudou. */
  async atualizarThread(conversaId: string): Promise<void> {
    if (this.selecionadaId() !== conversaId) return
    try {
      const t = await firstValueFrom(this.http.get<Thread>(`/v1/conversas/${conversaId}`))
      this.thread.set(t)
    } catch {
      // idem: silencioso.
    }
  }

  /**
   * Envia uma mensagem de texto na conversa aberta. A tela reflete na hora (e a
   * dos colegas, pelo evento de tempo real). Falha de envio vira mensagem
   * nomeada — não um erro genérico.
   */
  async enviar(): Promise<void> {
    const id = this.selecionadaId()
    const texto = this.rascunho().trim()
    if (!id || !texto || this.enviando()) return
    this.enviando.set(true)
    this.erroEnvio.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/conversas/${id}/mensagens`, { tipo: 'texto', texto }))
      this.rascunho.set('')
      await this.atualizarThread(id)
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string; motivo?: string } | null) : null
      this.erroEnvio.set(corpo?.mensagem ?? corpo?.motivo ?? 'Não foi possível enviar a mensagem.')
    } finally {
      this.enviando.set(false)
    }
  }
}

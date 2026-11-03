import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { formatarTelefoneBR } from '@geracrm/shared'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, GradeFormComponente,
  IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente, ToastServico, mensagemDeErro,
  type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'
import { evidenciaValida, rotuloBloqueio } from './lgpd.regras.js'

interface Bloqueio {
  readonly chave: string
  readonly motivo: string
  readonly origem: string | null
  readonly bloqueadoEm: string
  /** O titular pediu para ser esquecido (LGPD): só sai por novo consentimento, registrado por admin. */
  readonly lgpd?: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Gestão de opt-out (EP-04). ⚠️ O envio já respeita a lista no servidor (gateway
 * E5-13) — esta tela é só para VER e MEXER. Bloquear é por telefone; o servidor
 * deriva a chave (55+DDD+8, vale com e sem o nono dígito).
 *
 * ⚠️ Desbloquear grava consentimento concedido no contato (e o tira da anonimização por opt-out).
 *    Número com bloqueio LGPD não desbloqueia: o admin registra o NOVO CONSENTIMENTO do titular,
 *    com a evidência (`POST /v1/bloqueios/:chave/novo-consentimento`), que fica auditado.
 */
@Component({
  selector: 'app-bloqueios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, DatePipe, EstadoComponente,
    GradeFormComponente, IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Opt-out / Bloqueios"
      subtitulo="Quem está aqui não recebe mensagem nossa — o envio bloqueia sozinho.">
      <button type="button" class="btn btn--primario" (click)="bloqueando.set(true)">
        <ui-icone nome="ban" />Bloquear número
      </button>
    </ui-cabecalho-tela>

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Você não tem acesso a esta lista" descricao="Peça a um administrador para liberar." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a lista de bloqueios" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chaveDaLinha">
            <ng-template uiCelula="telefone" let-l>{{ formatarChave(l.chave) }}</ng-template>
            <ng-template uiCelula="motivo" let-l>{{ rotuloMotivo(l.motivo, l.lgpd === true) }}</ng-template>
            <ng-template uiCelula="bloqueadoEm" let-l>{{ l.bloqueadoEm | date: 'dd/MM/yy' }}</ng-template>
            <ng-template uiCelula="acoes" let-l>
              <span class="acoes">
                @if (l.lgpd) {
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirConsentimento(l.chave)"
                          title="O titular pediu para ser esquecido. Só libera com o novo consentimento dele.">
                    Novo consentimento
                  </button>
                } @else {
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="remover(l.chave)"
                          [disabled]="removendo().has(l.chave)">
                    {{ removendo().has(l.chave) ? 'Desbloqueando…' : 'Desbloquear' }}
                  </button>
                }
              </span>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Ninguém bloqueado"
                descricao="Quando um cliente pedir para não receber, bloqueie aqui — ou o webhook de opt-out cuida sozinho.">
                <button type="button" class="btn btn--primario" (click)="bloqueando.set(true)">Bloquear número</button>
              </ui-estado>
            </div>
          </ui-tabela>
          <ui-paginacao [mostrados]="itens().length" [temMais]="proximoCursor() !== null"
            [carregando]="carregandoMais()" (mais)="carregarMais()" />
        }
      }
    </div>

    <ui-modal [aberto]="bloqueando()" titulo="Bloquear número" largura="p" (fechar)="fecharBloqueio()">
      <form id="form-bloquear" (submit)="adicionar($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="Telefone a bloquear" mascara="telefone" placeholder="(81) 99999-0000"
            dica="Com DDD. Vale com e sem o nono dígito." [obrigatorio]="true" [(valor)]="telefone"
            [erro]="erroTelefone()" />
        </ui-grade-form>
        @if (erroEnvio(); as e) { <p class="erro-envio" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharBloqueio()">Cancelar</button>
        <button type="submit" form="form-bloquear" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Bloqueando…' : 'Bloquear' }}
        </button>
      </div>
    </ui-modal>

    <ui-modal [aberto]="consentindo() !== null" titulo="Novo consentimento do titular" largura="p" (fechar)="fecharConsentimento()">
      <form id="form-consentimento" (submit)="registrarConsentimento($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="Evidência do consentimento do titular" tipo="textarea" [obrigatorio]="true"
            dica="Onde, quando e protocolo. Fica auditado." [(valor)]="evidencia" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharConsentimento()">Cancelar</button>
        <button type="submit" form="form-consentimento" class="btn btn--primario" [disabled]="registrando() || !evidenciaOk()">
          {{ registrando() ? 'Registrando…' : 'Registrar e liberar' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .acoes { display: inline-flex; gap: var(--espacamento-2); }
    .erro-envio { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class BloqueiosPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'telefone', rotulo: 'Telefone', mono: true },
    { chave: 'motivo', rotulo: 'Motivo' },
    { chave: 'bloqueadoEm', rotulo: 'Desde', mono: true, largura: '110px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '260px' },
  ]
  protected readonly chaveDaLinha = (l: LinhaTabela): string => String(l['chave'])

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Bloqueio[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly bloqueando = signal(false)
  readonly telefone = signal('')
  readonly salvando = signal(false)
  readonly erroTelefone = signal<string | null>(null)
  readonly erroEnvio = signal<string | null>(null)
  readonly removendo = signal<ReadonlySet<string>>(new Set())
  readonly consentindo = signal<string | null>(null)
  readonly evidencia = signal('')
  readonly registrando = signal(false)

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Bloqueio[]; proximoCursor: string | null }>('/v1/bloqueios'))
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Bloqueio[]; proximoCursor: string | null }>(
        `/v1/bloqueios?cursor=${encodeURIComponent(cursor)}`))
      this.itens.update((a) => [...a, ...r.itens])
      this.proximoCursor.set(r.proximoCursor)
    } catch { /* mantém */ } finally { this.carregandoMais.set(false) }
  }

  async adicionar(ev: Event): Promise<void> {
    ev.preventDefault()
    const tel = this.telefone().replace(/\D/g, '')
    if (this.salvando()) return
    if (!tel) { this.erroTelefone.set('Informe o telefone com DDD.'); return }
    this.salvando.set(true)
    this.erroTelefone.set(null)
    this.erroEnvio.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/bloqueios', { telefone: tel }))
      this.telefone.set('')
      this.bloqueando.set(false)
      await this.carregar()
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 422) this.erroTelefone.set('Telefone inválido. Confira o número.')
      else this.erroEnvio.set('Não foi possível bloquear.')
    } finally { this.salvando.set(false) }
  }

  fecharBloqueio(): void { if (!this.salvando()) this.bloqueando.set(false) }

  async remover(chave: string): Promise<void> {
    this.removendo.update((s) => new Set(s).add(chave))
    try {
      await firstValueFrom(this.http.delete(`/v1/bloqueios/${chave}`))
      this.itens.update((a) => a.filter((b) => b.chave !== chave))
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível desbloquear.'))
    } finally {
      this.removendo.update((s) => { const n = new Set(s); n.delete(chave); return n })
    }
  }

  evidenciaOk(): boolean { return evidenciaValida(this.evidencia()) }

  abrirConsentimento(chave: string): void { this.evidencia.set(''); this.consentindo.set(chave) }

  fecharConsentimento(): void { if (!this.registrando()) this.consentindo.set(null) }

  async registrarConsentimento(ev: Event): Promise<void> {
    ev.preventDefault()
    const chave = this.consentindo()
    if (!chave || this.registrando() || !this.evidenciaOk()) return
    this.registrando.set(true)
    try {
      await firstValueFrom(this.http.post(`/v1/bloqueios/${chave}/novo-consentimento`, { origem: 'titular', evidencia: this.evidencia().trim() }))
      this.itens.update((a) => a.filter((b) => b.chave !== chave))
      this.consentindo.set(null)
      this.toast.sucesso('Consentimento registrado; o número foi liberado.')
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível registrar o consentimento.'))
    } finally { this.registrando.set(false) }
  }

  /** ⚠️ A formatação mora em @geracrm/shared: era uma cópia local, e a segunda
   *  cópia (no card de leads) seria a divergência garantida em um mês. */
  formatarChave(c: string): string { return formatarTelefoneBR(c) }

  rotuloMotivo(m: string, lgpd = false): string { return rotuloBloqueio(m, lgpd) }
}

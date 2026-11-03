import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { formatarTelefoneBR } from '@geracrm/shared'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ToastServico, mensagemDeErro } from '../../compartilhado/ui/index.js'
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
  imports: [DatePipe],
  template: `
    <header class="cabecalho">
      <h1>Opt-out / Bloqueios</h1>
      <p class="sub">Quem está aqui não recebe mensagem nossa — o envio bloqueia sozinho.</p>
    </header>

    <form class="add" (submit)="adicionar($event)">
      <label class="campo rotulado">
        <span>Telefone a bloquear</span>
        <input [value]="telefone()" (input)="telefone.set($any($event.target).value)"
               placeholder="81 99999-0000" inputmode="tel" />
      </label>
      <button class="btn btn--primario" type="submit" [disabled]="salvando() || !telefone().trim()">
        {{ salvando() ? 'Bloqueando…' : 'Bloquear' }}
      </button>
    </form>
    @if (erroAdd(); as e) { <p class="erro-add" role="alert">{{ e }}</p> }

    @switch (estado()) {
      @case ('carregando') { <div class="bloco"><div class="esqueleto"></div><div class="esqueleto"></div></div> }
      @case ('sem_permissao') {
        <div class="bloco aviso"><h2>Você não tem acesso a esta lista</h2>
          <p>Peça a um administrador para liberar.</p></div>
      }
      @case ('erro') {
        <div class="bloco aviso"><h2>Não foi possível carregar</h2>
          <button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div>
      }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco vazio"><h2>Ninguém bloqueado</h2>
            <p>Quando um cliente pedir para não receber, bloqueie aqui — ou o webhook de opt-out cuida sozinho.</p></div>
        } @else {
          <ul class="lista">
            @for (b of itens(); track b.chave) {
              <li class="item">
                <span class="tel">{{ formatarChave(b.chave) }}</span>
                <span class="motivo">{{ rotuloMotivo(b.motivo, b.lgpd === true) }}</span>
                <span class="quando">{{ b.bloqueadoEm | date: 'dd/MM/yy' }}</span>
                @if (b.lgpd) {
                  <button class="btn btn--secundario btn--pequeno" type="button" (click)="abrirConsentimento(b.chave)"
                          title="O titular pediu para ser esquecido. Só libera com o novo consentimento dele.">
                    Novo consentimento
                  </button>
                } @else {
                  <button class="btn btn--secundario btn--pequeno" (click)="remover(b.chave)" [disabled]="removendo().has(b.chave)">
                    {{ removendo().has(b.chave) ? '…' : 'Desbloquear' }}
                  </button>
                }
                @if (consentindo() === b.chave) {
                  <form class="consentimento" (submit)="registrarConsentimento($event, b.chave)">
                    <label class="campo rotulado">
                      <span>Evidência do consentimento do titular (onde, quando, protocolo)</span>
                      <textarea rows="2" maxlength="500" [value]="evidencia()" (input)="evidencia.set($any($event.target).value)"></textarea>
                    </label>
                    <div class="acoes-consentimento">
                      <button class="btn btn--secundario btn--pequeno" type="button" (click)="consentindo.set(null)">Cancelar</button>
                      <button class="btn btn--primario btn--pequeno" type="submit" [disabled]="registrando() || !evidenciaOk()">
                        {{ registrando() ? 'Registrando…' : 'Registrar e liberar' }}
                      </button>
                    </div>
                  </form>
                }
              </li>
            }
          </ul>
          @if (proximoCursor()) {
            <button class="btn btn--secundario mais" (click)="carregarMais()" [disabled]="carregandoMais()">
              {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
            </button>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .add { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-2); align-items: end; }
    .add .campo { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .add .campo > span { font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .add input { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .erro-add { color: var(--erro); font-size: 13px; margin: 0 0 var(--espacamento-3); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; margin-top: var(--espacamento-4); }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .esqueleto { height: 40px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: var(--espacamento-4) 0 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); overflow: hidden; }
    .item { display: grid; grid-template-columns: 1fr auto auto auto; gap: var(--espacamento-3); align-items: center;
      padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); font-size: 13px; }
    .item:last-child { border-bottom: none; }
    .tel { font-family: var(--tipografia-familia-dados); color: var(--texto); }
    .motivo { color: var(--texto-secundario); }
    .quando { color: var(--texto-suave); font-family: var(--tipografia-familia-dados); }
    .mais { margin-top: var(--espacamento-4); }
    .consentimento { grid-column: 1 / -1; display: grid; gap: var(--espacamento-2); }
    .consentimento .campo { display: flex; flex-direction: column; gap: 4px; }
    .consentimento .campo > span { font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .consentimento textarea { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; resize: vertical; }
    .acoes-consentimento { display: flex; justify-content: flex-end; gap: var(--espacamento-2); }
  `,
})
export class BloqueiosPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Bloqueio[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly telefone = signal('')
  readonly salvando = signal(false)
  readonly erroAdd = signal<string | null>(null)
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
    const tel = this.telefone().trim()
    if (!tel || this.salvando()) return
    this.salvando.set(true)
    this.erroAdd.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/bloqueios', { telefone: tel }))
      this.telefone.set('')
      await this.carregar()
    } catch (e) {
      this.erroAdd.set(e instanceof HttpErrorResponse && e.status === 422
        ? 'Telefone inválido. Confira o número.' : 'Não foi possível bloquear.')
    } finally { this.salvando.set(false) }
  }

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

  async registrarConsentimento(ev: Event, chave: string): Promise<void> {
    ev.preventDefault()
    if (this.registrando() || !this.evidenciaOk()) return
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

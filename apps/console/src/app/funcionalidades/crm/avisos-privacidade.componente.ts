import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { PaginaAvisosPrivacidade } from '@geracrm/shared'
import { EsqueletoComponente, queryDeLista } from '../../compartilhado/ui/index.js'
import {
  CARREGANDO, falhaNaPrimeira, maisChegou, maisFalhou, pedirMais, primeiraPagina, rotuloOrigem, type EstadoAvisos,
} from './avisos-privacidade.estado.js'

/**
 * AVISOS DE PRIVACIDADE do contato (P4; LGPD) — a prova de quando, em que
 * conversa e com que texto o aviso foi exibido. Só leitura: prova não se edita.
 *
 * Paginada por CURSOR (`GET /v1/contatos/:id/avisos-privacidade`), com os cinco
 * estados como ramos explícitos (`avisos-privacidade.estado.ts`). Sem
 * permissão, o bloco inteiro some — não é erro.
 */
@Component({
  selector: 'app-avisos-privacidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, EsqueletoComponente],
  template: `
    @switch (estado().tipo) {
      @case ('sem_permissao') {}
      @default {
        <div class="cartao">
          <h3>Avisos de privacidade</h3>
          @switch (estado().tipo) {
            @case ('carregando') {
              <div class="esq" aria-busy="true" aria-label="Carregando avisos de privacidade">
                <ui-esqueleto altura="14px" largura="70%" /><ui-esqueleto altura="14px" largura="90%" />
              </div>
            }
            @case ('vazio') {
              <p class="vazio-mini">Nenhum aviso exibido a este contato ainda. Ele aparece aqui quando a abertura
                 do agente (com o aviso de privacidade) é enviada numa conversa.</p>
            }
            @case ('erro') {
              <p class="erro-mini" role="alert">{{ mensagemErro() }}</p>
              <button class="btn btn--secundario btn--pequeno" type="button" (click)="carregar()">Tentar de novo</button>
            }
            @case ('pronto') {
              <ul class="avisos">
                @for (a of itens(); track a.id) {
                  <li>
                    <div class="linha">
                      <span class="txt-dados quando">{{ a.exibidoEm | date: 'dd/MM/yy HH:mm' }}</span>
                      <span class="mini">{{ origem(a.origem) }}</span>
                      <span class="mini txt-dados" title="Versão do aviso">v. {{ a.versao }}</span>
                    </div>
                    <p class="texto">{{ a.texto }}</p>
                  </li>
                }
              </ul>
              @if (erroMais(); as e) { <p class="erro-mini" role="alert">{{ e }}</p> }
              @if (temMais()) {
                <button class="btn btn--secundario btn--pequeno mais" type="button" (click)="carregarMais()" [disabled]="carregandoMais()">
                  {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
                </button>
              }
            }
          }
        </div>
      }
    }
  `,
  styles: `
    .cartao { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    h3 { margin: 0 0 var(--espacamento-2); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); }
    .esq { display: grid; gap: var(--espacamento-2); }
    .avisos { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .linha { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); }
    .quando { font-size: 12px; color: var(--texto-secundario); }
    .texto { margin: var(--espacamento-1) 0 0; font-size: 13px; color: var(--texto); overflow-wrap: anywhere; }
    .mini { font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: 0 var(--espacamento-1); }
    .vazio-mini { font-size: 13px; color: var(--texto-suave); margin: 0; }
    .erro-mini { font-size: 13px; color: var(--erro); margin: 0 0 var(--espacamento-2); }
    .mais { margin-top: var(--espacamento-3); }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
  `,
})
export class AvisosPrivacidadeComponente {
  private readonly http = inject(HttpClient)
  readonly contatoId = input.required<string>()
  readonly estado = signal<EstadoAvisos>(CARREGANDO)
  /** Descarta resposta de um contato anterior (navegação entre fichas). */
  private serie = 0

  constructor() {
    effect(() => { if (this.contatoId()) void this.carregar() })
  }

  itens() { const e = this.estado(); return e.tipo === 'pronto' ? e.itens : [] }
  temMais(): boolean { const e = this.estado(); return e.tipo === 'pronto' && !!e.proximoCursor }
  carregandoMais(): boolean { const e = this.estado(); return e.tipo === 'pronto' && e.carregandoMais }
  erroMais(): string | null { const e = this.estado(); return e.tipo === 'pronto' ? e.erroMais : null }
  mensagemErro(): string { const e = this.estado(); return e.tipo === 'erro' ? e.mensagem : '' }
  origem(o: 'agente' | 'humano'): string { return rotuloOrigem(o) }

  private pagina(cursor: string | null): Promise<PaginaAvisosPrivacidade> {
    return firstValueFrom(this.http.get<PaginaAvisosPrivacidade>(
      `/v1/contatos/${this.contatoId()}/avisos-privacidade${queryDeLista({ cursor })}`))
  }

  async carregar(): Promise<void> {
    const serie = ++this.serie
    this.estado.set(CARREGANDO)
    try {
      const p = await this.pagina(null)
      if (serie === this.serie) this.estado.set(primeiraPagina(p))
    } catch (e) {
      if (serie === this.serie) this.estado.set(falhaNaPrimeira(e instanceof HttpErrorResponse ? e.status : -1))
    }
  }

  async carregarMais(): Promise<void> {
    const antes = this.estado()
    const pedido = pedirMais(antes)
    if (pedido === antes || pedido.tipo !== 'pronto') return
    const serie = this.serie
    this.estado.set(pedido)
    try {
      const p = await this.pagina(pedido.proximoCursor)
      if (serie === this.serie) this.estado.update((e) => maisChegou(e, p))
    } catch {
      if (serie === this.serie) this.estado.update(maisFalhou)
    }
  }
}

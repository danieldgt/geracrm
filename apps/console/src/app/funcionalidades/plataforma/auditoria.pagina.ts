import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { AuditoriaServico, type EntradaAuditoria } from './auditoria.servico.js'

/**
 * Gestão → Auditoria (EP-07 / PLT-05).
 *
 * ⚠️ Os cinco estados são ramos explícitos. Um rastro vazio ("nada aconteceu
 * ainda") e uma falha de carga pedem telas opostas — derivar do tamanho da
 * lista mostraria "nenhuma ação" quando a API caiu.
 *
 * Lê sob RLS: cada tenant só vê o próprio rastro. Paginação por cursor
 * ("carregar mais") — nunca a lista inteira.
 */
@Component({
  selector: 'app-auditoria',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <header class="cabecalho">
      <h1>Auditoria</h1>
      <p class="sub">Quem fez o quê e quando. O rastro não é editável — é registro.</p>
    </header>

    @switch (servico.estado()) {
      @case ('carregando') {
        <div class="lista" aria-busy="true">
          <div class="esqueleto"></div><div class="esqueleto"></div><div class="esqueleto"></div>
        </div>
      }
      @case ('sem_permissao') {
        <div class="bloco aviso">
          <h2>Você não tem acesso à auditoria</h2>
          <p>Peça a um administrador da sua empresa para liberar este acesso.</p>
        </div>
      }
      @case ('erro') {
        <div class="bloco aviso">
          <h2>Não foi possível carregar a auditoria</h2>
          <p>{{ servico.erro() }}</p>
          <button (click)="servico.carregar()">Tentar de novo</button>
        </div>
      }
      @case ('pronto') {
        @if (servico.itens().length === 0) {
          <div class="bloco vazio">
            <h2>Nenhuma ação registrada ainda</h2>
            <p>Assim que alguém assumir, editar ou apagar algo, aparece aqui.</p>
          </div>
        } @else {
          <ol class="lista">
            @for (e of servico.itens(); track e.criadoEm + e.acao + (e.entidadeId ?? '')) {
              <li class="linha">
                <span class="quando">{{ e.criadoEm | date: 'dd/MM/yy HH:mm' }}</span>
                <span class="ator">{{ e.atorNome ?? 'Sistema' }}</span>
                <span class="acao">{{ rotuloAcao(e.acao) }}</span>
                <span class="detalhe">{{ detalhe(e) }}</span>
              </li>
            }
          </ol>

          @if (servico.proximoCursor()) {
            <button class="mais" (click)="servico.carregarMais()" [disabled]="servico.carregandoMais()">
              {{ servico.carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
            </button>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-6); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); overflow: hidden; }
    .esqueleto { height: 44px; border-bottom: 1px solid var(--borda); background: var(--superficie); }
    .linha { display: grid; grid-template-columns: 120px 140px 180px 1fr; gap: var(--espacamento-3); align-items: baseline; padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); font-size: 13px; }
    .linha:last-child { border-bottom: none; }
    .quando { font-family: var(--tipografia-familia-dados); color: var(--texto-suave); }
    .ator { color: var(--texto); font-weight: 500; }
    .acao { color: var(--texto-secundario); }
    .detalhe { color: var(--texto-suave); }
    .mais { margin-top: var(--espacamento-4); padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    .mais:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .mais:disabled { opacity: .6; cursor: default; }
    button { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    @media (max-width: 640px) {
      .linha { grid-template-columns: 1fr; gap: 2px; }
    }
  `,
})
export class AuditoriaPagina implements OnInit {
  readonly servico = inject(AuditoriaServico)

  ngOnInit(): void {
    void this.servico.carregar()
  }

  /** ⚠️ Rótulo no vocabulário da operação, não o código cru do evento. */
  rotuloAcao(acao: string): string {
    switch (acao) {
      case 'atendimento.assumido': return 'Assumiu o atendimento'
      case 'mensagem.apagada': return 'Apagou uma mensagem'
      case 'mensagem.editada': return 'Editou uma mensagem'
      default: return acao
    }
  }

  detalhe(e: EntradaAuditoria): string {
    const d = e.dados as Record<string, unknown> | null
    if (e.acao === 'atendimento.assumido' && d && 'protocolo' in d) {
      return `Protocolo #${String(d['protocolo'])}`
    }
    if (e.acao === 'mensagem.apagada' && d) {
      return d['paraTodos'] ? 'Para todos' : 'Só para mim'
    }
    return ''
  }
}

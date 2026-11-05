import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import {
  BadgeComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, PaginacaoComponente, TabelaComponente, ToastServico,
  mensagemDeErro, mesclarPagina, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'
import { MAX_COLUNAS_RESPOSTA, camposDaTabela, textoDaResposta, type CampoFormulario } from './formulario.regras.js'
import { FormulariosServico, type RespostaLinha } from './formularios.servico.js'

type EstadoLista = 'carregando' | 'pronto' | 'erro'

/** Respostas de um formulário: tabela por cursor, link para o contato e CSV completo (streaming na API). */
@Component({
  selector: 'app-formulario-respostas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente, TabelaComponente, RouterLink],
  template: `
    <div class="barra">
      <p class="nota">
        @if (campos().length > limite) { A tela mostra {{ limite }} campos; o CSV leva todos. } @else { O CSV leva as mesmas colunas. }
      </p>
      <button type="button" class="btn btn--secundario" [disabled]="baixando()" (click)="baixar()">
        {{ baixando() ? 'Gerando…' : 'Baixar CSV' }}
      </button>
    </div>
    @switch (estado()) {
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as respostas" [descricao]="erroLista()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        <ui-tabela [colunas]="colunas()" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
          <ng-template uiCelula="contato" let-l>
            @if (l.contatoId) { <a class="nome" [routerLink]="['/contato', l.contatoId]">{{ l.contato }}</a> } @else { <span>{{ l.contato }}</span> }
          </ng-template>
          <ng-template uiCelula="novo" let-l>
            @switch (l.verificacao) {
              @case ('pendente') {
                <div class="pendente">
                  <ui-badge tom="atencao">Não verificada</ui-badge>
                  <span class="aviso">Resposta não verificada — confirme antes de usar.</span>
                  <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="aplicando() === l.id" (click)="aplicar(l.id)">
                    {{ aplicando() === l.id ? 'Aplicando…' : 'Aplicar ao contato' }}
                  </button>
                </div>
              }
              @case ('aplicada') { <ui-badge tom="info">Aplicada ao contato</ui-badge> }
              @default { <ui-badge [tom]="l.novo ? 'sucesso' : 'info'">{{ l.novo ? 'Novo contato' : 'Já cadastrado' }}</ui-badge> }
            }
          </ng-template>
          <div uiVazio>
            <ui-estado titulo="Nenhuma resposta ainda" descricao="Quando alguém preencher o formulário público, a resposta aparece aqui." />
          </div>
        </ui-tabela>
        @if (estado() === 'pronto') {
          <ui-paginacao [mostrados]="itens().length" [temMais]="cursor() !== null"
            [carregando]="carregandoMais()" (mais)="carregarMais()" />
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .barra { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); flex-wrap: wrap; }
    .nota { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    ui-tabela { display: block; }
    .nome { color: var(--texto); text-decoration: none; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .pendente { display: grid; gap: var(--espacamento-1); justify-items: start; min-width: 0; }
    .aviso { color: var(--texto-secundario); font-size: 12px; line-height: 1.3; white-space: normal; }
  `,
})
export class FormularioRespostasComponente implements OnInit {
  readonly formularioId = input.required<string>()
  readonly slug = input.required<string>()
  readonly campos = input.required<readonly CampoFormulario[]>()

  private readonly api = inject(FormulariosServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly limite = MAX_COLUNAS_RESPOSTA
  protected readonly estado = signal<EstadoLista>('carregando')
  protected readonly erroLista = signal('')
  protected readonly itens = signal<readonly RespostaLinha[]>([])
  protected readonly cursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)
  protected readonly baixando = signal(false)
  protected readonly aplicando = signal<string | null>(null)

  private readonly colunasDeCampo = computed(() => camposDaTabela(this.campos()))
  protected readonly colunas = computed<ColunaTabela[]>(() => [
    { chave: 'quando', rotulo: 'Data', mono: true, largura: '150px' },
    { chave: 'contato', rotulo: 'Contato' },
    { chave: 'novo', rotulo: 'Situação', largura: '200px' },
    ...this.colunasDeCampo().map((c, i) => ({ chave: `c${i}`, rotulo: c.rotulo })),
  ])
  protected readonly linhas = computed<readonly LinhaTabela[]>(() => this.itens().map((r) => {
    const linha: Record<string, unknown> = {
      id: r.id, contatoId: r.contatoId, contato: r.contatoNome ?? 'Contato removido', novo: r.contatoNovo,
      verificacao: r.verificacao,
      quando: new Date(r.criadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
    }
    this.colunasDeCampo().forEach((c, i) => { linha[`c${i}`] = textoDaResposta(c, r.respostas[c.id]) })
    return linha as unknown as LinhaTabela
  }))

  ngOnInit(): void { void this.carregar() }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.api.respostas(this.formularioId(), null)
      this.itens.set(r.itens)
      this.cursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.erroLista.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.'))
      this.estado.set('erro')
    }
  }

  protected async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.api.respostas(this.formularioId(), c)
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (x) => x.id))
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais respostas.'))
    } finally { this.carregandoMais.set(false) }
  }

  /**
   * ⚠️ Quem preencheu é anônimo: o telefone bater com um cliente não prova que é ele. O gestor confere
   * (ligando, pela conversa) e só então os dados entram na ficha — só o que faltava, auditado.
   */
  protected async aplicar(respostaId: string): Promise<void> {
    if (this.aplicando()) return
    const ok = await this.confirmacao.confirmar({
      titulo: 'Aplicar a resposta ao contato?',
      mensagem: 'Confirme que a resposta é mesmo do dono deste cadastro. O e-mail, o documento e os anexos entram na ficha '
        + '(só o que estiver faltando; nada é sobrescrito). O consentimento do formulário não é copiado.',
      acao: 'Aplicar ao contato',
    })
    if (!ok) return
    this.aplicando.set(respostaId)
    try {
      await this.api.aplicarResposta(respostaId)
      this.itens.update((l) => l.map((r) => (r.id === respostaId ? { ...r, verificacao: 'aplicada' as const } : r)))
      this.toast.sucesso('Resposta aplicada ao contato.')
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível aplicar a resposta.'))
    } finally { this.aplicando.set(null) }
  }

  protected async baixar(): Promise<void> {
    this.baixando.set(true)
    try { await this.api.baixarCsv(this.formularioId(), this.slug()) }
    catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível gerar o CSV.')) }
    finally { this.baixando.set(false) }
  }
}

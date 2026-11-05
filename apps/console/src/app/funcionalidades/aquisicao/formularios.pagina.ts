import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import {
  BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, PaginacaoComponente,
  TabelaComponente, ToastServico, ehStatus, mensagemDeErro, mesclarPagina, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'
import { ROTULO_TIPO_FORM, linkPublico, type TipoFormulario } from './formulario.regras.js'
import { FormulariosServico, type FormularioLista } from './formularios.servico.js'

type EstadoLista = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/**
 * Formulários públicos (F3) — padrão Lista: nome, tipo, respostas, situação e o link público com "Copiar".
 * Criar/editar leva ao builder (`/formularios/novo`, `/formularios/:id`).
 */
@Component({
  selector: 'app-formularios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente, TabelaComponente, RouterLink],
  template: `
    <ui-cabecalho-tela titulo="Formulários"
      subtitulo="Links públicos que criam contatos: quem preenche entra na base (ou é reconhecido pelo telefone) já com origem e responsável.">
      <a class="btn btn--primario" routerLink="/formularios/novo">+ Novo formulário</a>
    </ui-cabecalho-tela>

    <div class="corpo">
      @switch (estado()) {
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso aos formulários" descricao="Peça acesso a um gestor ou administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar os formulários" [descricao]="erroLista()">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @default {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
            <ng-template uiCelula="nome" let-f>
              <a class="nome" [routerLink]="['/formularios', f.id]">{{ f.nome }}</a>
            </ng-template>
            <ng-template uiCelula="tipo" let-f>{{ rotuloTipo(f.tipo) }}</ng-template>
            <ng-template uiCelula="ativo" let-f>
              <ui-badge [tom]="f.ativo ? 'sucesso' : 'neutro'">{{ f.ativo ? 'Ativo' : 'Inativo' }}</ui-badge>
            </ng-template>
            <ng-template uiCelula="link" let-f>
              <span class="link">
                <code class="url" [title]="link(f)">{{ caminho(f) }}</code>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="copiar(f)">Copiar</button>
              </span>
            </ng-template>
            <ng-template uiCelula="acoes" let-f>
              <span class="acoes">
                <a class="btn btn--secundario btn--pequeno" [routerLink]="['/formularios', f.id]">Editar</a>
                <button type="button" class="btn btn--perigo btn--pequeno" (click)="apagar(f)">Excluir</button>
              </span>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nenhum formulário ainda"
                descricao="Monte um formulário, publique o link e cada resposta vira um contato na sua base.">
                <a class="btn btn--primario" routerLink="/formularios/novo">+ Novo formulário</a>
              </ui-estado>
            </div>
          </ui-tabela>
          @if (estado() === 'pronto') {
            <ui-paginacao [mostrados]="itens().length" [temMais]="cursor() !== null"
              [carregando]="carregandoMais()" (mais)="carregarMais()" />
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    ui-tabela { display: block; }
    .nome { color: var(--texto); font-weight: 500; text-decoration: none; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .link { display: inline-flex; align-items: center; gap: var(--espacamento-2); max-width: 100%; min-width: 0; }
    .url { font-family: var(--tipografia-familia-dados); font-size: 12px; color: var(--texto-secundario);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .acoes { display: inline-flex; gap: var(--espacamento-2); }
  `,
})
export class FormulariosPagina implements OnInit {
  private readonly api = inject(FormulariosServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Formulário' },
    { chave: 'tipo', rotulo: 'Tipo', largura: '130px' },
    { chave: 'totalRespostas', rotulo: 'Respostas', mono: true, alinhamento: 'dir', largura: '110px' },
    { chave: 'ativo', rotulo: 'Situação', largura: '110px' },
    { chave: 'link', rotulo: 'Link público', largura: '320px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '180px' },
  ]

  protected readonly estado = signal<EstadoLista>('carregando')
  protected readonly erroLista = signal('')
  protected readonly itens = signal<readonly FormularioLista[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly cursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)

  ngOnInit(): void { void this.carregar() }

  protected rotuloTipo(t: string): string { return ROTULO_TIPO_FORM[t as TipoFormulario] ?? t }
  protected link(f: FormularioLista): string { return linkPublico(window.location.origin, f.chavePublica) }
  protected caminho(f: FormularioLista): string { return `/f/${f.chavePublica}` }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.api.listar(null)
      this.itens.set(r.itens)
      this.cursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) this.estado.set('sem_permissao')
      else { this.erroLista.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro') }
    }
  }

  protected async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.api.listar(c)
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (f) => f.id))
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais formulários.'))
    } finally { this.carregandoMais.set(false) }
  }

  protected async copiar(f: FormularioLista): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link(f))
      this.toast.sucesso('Link copiado.')
    } catch {
      this.toast.erro('Não foi possível copiar. Selecione o link e copie à mão.')
    }
  }

  protected async apagar(f: FormularioLista): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: `Excluir "${f.nome}"?`,
      mensagem: f.totalRespostas > 0
        ? `As ${f.totalRespostas} resposta(s) deste formulário serão apagadas. Os contatos criados por ele continuam na base. O link deixa de funcionar.`
        : 'O link deixa de funcionar.',
      acao: 'Excluir', perigo: true,
    })
    if (!ok) return
    try {
      await this.api.remover(f.id)
      this.toast.sucesso('Formulário excluído.')
      await this.carregar()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível excluir.'))
    }
  }
}

import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BotaoComponente, ConfirmacaoServico, EsqueletoComponente, EstadoComponente, IconeComponente, PaginacaoComponente,
  ToastServico, mensagemDeErro, mesclarPagina,
} from '../../compartilhado/ui/index.js'
import { FichaBlocosServico, type ArquivoContato } from './ficha-blocos.servico.js'
import { ACEITA_ARQUIVO, formatarTamanho, validarArquivo } from './ficha.regras.js'

/**
 * Arquivos do contato (lateral): lista por cursor, enviar (até 15 MB), baixar por URL assinada curta
 * e remover. ⚠️ "Enviar no WhatsApp" NÃO existe ainda: o chat só envia mídia colada (base64), não por
 * id de arquivo — então aqui só baixa. Estado próprio: falhar aqui não derruba a ficha.
 */
@Component({
  selector: 'app-ficha-arquivos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BotaoComponente, EsqueletoComponente, EstadoComponente, IconeComponente, PaginacaoComponente],
  template: `
    <div class="cab">
      <h3 class="txt-rotulo">Arquivos</h3>
      <input #escolha class="oculto" type="file" [accept]="aceita" (change)="escolher($event)" aria-label="Escolher arquivo" />
      <ui-botao variante="secundario" [carregando]="enviando()" [desabilitado]="!bucket()" (click)="escolha.click()">
        <ui-icone nome="upload" [tamanho]="14" /> Enviar arquivo
      </ui-botao>
    </div>
    @if (!bucket()) {
      <p class="txt-denso aviso">O armazenamento de arquivos não está configurado neste ambiente.</p>
    }
    @if (erroEnvio()) { <p class="txt-denso erro" role="alert">{{ erroEnvio() }}</p> }

    @switch (estado()) {
      @case ('carregando') { <div aria-busy="true"><ui-esqueleto altura="40px" /></div> }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar os arquivos" [descricao]="erro()">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado>
      }
      @default {
        @if (itens().length === 0) {
          <p class="txt-denso vazio">Nenhum arquivo. Anexe contrato, proposta ou planilha (PDF, imagem, Word, planilha ou texto, até 15 MB).</p>
        } @else {
          <ul class="lista">
            @for (a of itens(); track a.id) {
              <li class="arq">
                <div class="info">
                  <span class="nome txt-corpo">{{ a.nome }}</span>
                  <span class="meta txt-denso">{{ tamanho(a.tamanhoBytes) }} · {{ a.criadoEm | date: 'dd/MM/yy' }}@if (a.enviadoPor) { · {{ a.enviadoPor.nome }} }</span>
                  @if (a.legenda) { <span class="meta txt-denso">{{ a.legenda }}</span> }
                </div>
                <div class="acoes">
                  <button type="button" class="btn btn--fantasma btn--pequeno" [disabled]="baixando() === a.id"
                          (click)="baixar(a)" [attr.aria-label]="'Baixar ' + a.nome"><ui-icone nome="download" [tamanho]="14" /></button>
                  <button type="button" class="btn btn--perigo btn--pequeno" (click)="remover(a)"
                          [attr.aria-label]="'Remover ' + a.nome"><ui-icone nome="trash-2" [tamanho]="14" /></button>
                </div>
              </li>
            }
          </ul>
          <ui-paginacao [mostrados]="itens().length" [temMais]="!!proximo()" [carregando]="carregandoMais()" (mais)="mais()" />
        }
      }
    }
  `,
  styles: `
    :host { display: block; }
    .cab { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); margin-bottom: var(--espacamento-2); }
    .cab h3 { margin: 0; }
    .oculto { display: none; }
    .aviso { color: var(--atencao); margin: 0 0 var(--espacamento-2); }
    .erro { color: var(--erro); margin: 0 0 var(--espacamento-2); }
    .vazio { color: var(--texto-secundario); margin: 0; }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .arq { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2);
      padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); }
    .info { display: grid; min-width: 0; }
    .nome { color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--texto-secundario); }
    .acoes { display: flex; gap: var(--espacamento-1); flex: none; }
  `,
})
export class FichaArquivosComponente {
  private readonly blocos = inject(FichaBlocosServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  readonly contatoId = input.required<string>()
  /** O feed registra envio e remoção: o pai recarrega a linha do tempo. */
  readonly alterou = output<void>()

  readonly aceita = ACEITA_ARQUIVO
  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly erro = signal('')
  readonly itens = signal<readonly ArquivoContato[]>([])
  readonly proximo = signal<string | null>(null)
  readonly bucket = signal(true)
  readonly carregandoMais = signal(false)
  readonly enviando = signal(false)
  readonly baixando = signal<string | null>(null)
  readonly erroEnvio = signal('')
  readonly tamanho = formatarTamanho

  constructor() {
    effect(() => { this.contatoId(); untracked(() => { void this.carregar() }) })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const p = await this.blocos.arquivos(this.contatoId(), null)
      this.itens.set(p.itens); this.proximo.set(p.proximoCursor); this.bucket.set(p.bucketDisponivel)
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Tente de novo em instantes.'))
      this.estado.set('erro')
    }
  }

  async mais(): Promise<void> {
    const cursor = this.proximo()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const p = await this.blocos.arquivos(this.contatoId(), cursor)
      this.itens.update((a) => mesclarPagina(a, p.itens, (x) => x.id))
      this.proximo.set(p.proximoCursor)
    } catch (e) {
      this.erroEnvio.set(mensagemDeErro(e, 'Não foi possível carregar mais arquivos.'))
    } finally {
      this.carregandoMais.set(false)
    }
  }

  async escolher(ev: Event): Promise<void> {
    const campo = ev.target as HTMLInputElement
    const arquivo = campo.files?.[0]
    campo.value = ''
    if (!arquivo) return
    this.erroEnvio.set('')
    const problema = validarArquivo(arquivo)
    if (problema) { this.erroEnvio.set(problema); return }
    this.enviando.set(true)
    try {
      await this.blocos.enviarArquivo(this.contatoId(), arquivo)
      this.toast.sucesso('Arquivo enviado')
      await this.carregar()
      this.alterou.emit()
    } catch (e) {
      this.erroEnvio.set(mensagemDeErro(e, 'Não foi possível enviar o arquivo.'))
    } finally {
      this.enviando.set(false)
    }
  }

  async baixar(a: ArquivoContato): Promise<void> {
    this.baixando.set(a.id)
    this.erroEnvio.set('')
    try {
      const r = await this.blocos.urlDoArquivo(this.contatoId(), a.id)
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      this.erroEnvio.set(mensagemDeErro(e, 'Não foi possível gerar o link do arquivo.'))
    } finally {
      this.baixando.set(null)
    }
  }

  async remover(a: ArquivoContato): Promise<void> {
    const ok = await this.confirmacao.confirmar({ titulo: 'Remover arquivo?', mensagem: `${a.nome} será apagado da ficha.`, acao: 'Remover' })
    if (!ok) return
    try {
      await this.blocos.removerArquivo(this.contatoId(), a.id)
      this.itens.update((l) => l.filter((x) => x.id !== a.id))
      this.toast.sucesso('Arquivo removido')
      this.alterou.emit()
    } catch (e) {
      this.erroEnvio.set(mensagemDeErro(e, 'Não foi possível remover o arquivo.'))
    }
  }
}

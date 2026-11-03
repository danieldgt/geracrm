import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core'
import { CampoComponente, SelectComponente, type OpcaoSelect } from '../../compartilhado/ui/index.js'
import { camposVisiveis, type CampoFormulario } from './formulario.regras.js'

/**
 * Renderiza um formulário a partir da definição: a MESMA peça serve à pré-visualização do builder e
 * à página pública. Só mostra o que a condicional libera (`camposVisiveis`, regra de `@geracrm/shared`).
 * Não envia nada: quem usa decide o que fazer com `valores`, `arquivos` e os erros.
 */
@Component({
  selector: 'app-formulario-render',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CampoComponente, SelectComponente],
  template: `
    <div class="campos">
      @for (c of visiveis(); track c.id) {
        @switch (c.tipo) {
          @case ('texto_longo') {
            <ui-campo class="largo" tipo="textarea" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? ''"
              [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('numero') {
            <ui-campo tipo="number" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? ''" [obrigatorio]="c.obrigatorio"
              [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('moeda') {
            <ui-campo tipo="dinheiro" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? '0,00'" [obrigatorio]="c.obrigatorio"
              [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('data') {
            <ui-campo tipo="date" [rotulo]="c.rotulo" [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()"
              [erro]="erros()[c.id] ?? null" [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('telefone') {
            <ui-campo tipo="tel" mascara="telefone" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? '(00) 00000-0000'"
              [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('email') {
            <ui-campo tipo="email" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? ''" [obrigatorio]="c.obrigatorio"
              [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('cpf') {
            <ui-campo mascara="cpf" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? '000.000.000-00'"
              [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('cnpj') {
            <ui-campo mascara="cnpj" [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? '00.000.000/0000-00'"
              [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('selecao') {
            <ui-select [rotulo]="c.rotulo" [placeholder]="c.placeholder || 'Selecione'" [opcoes]="opcoes(c)"
              [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('selecao_condicional') {
            <ui-select [rotulo]="c.rotulo" [placeholder]="c.placeholder || 'Selecione'" [opcoes]="opcoes(c)"
              [obrigatorio]="c.obrigatorio" [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
          @case ('escolha_unica') {
            <fieldset class="grupo largo" [disabled]="desabilitado()">
              <legend class="txt-denso">{{ c.rotulo }}@if (c.obrigatorio) { <span class="obrigatorio" aria-hidden="true">*</span> }</legend>
              @for (o of c.opcoes; track o) {
                <label class="opcao">
                  <input type="radio" [name]="c.id" [value]="o" [checked]="texto(c.id) === o" (change)="definir(c.id, o)" />
                  <span>{{ o }}</span>
                </label>
              }
              @if (erros()[c.id]) { <span class="msg-erro txt-denso" role="alert">{{ erros()[c.id] }}</span> }
            </fieldset>
          }
          @case ('multipla') {
            <fieldset class="grupo largo" [disabled]="desabilitado()">
              <legend class="txt-denso">{{ c.rotulo }}@if (c.obrigatorio) { <span class="obrigatorio" aria-hidden="true">*</span> }</legend>
              @for (o of c.opcoes; track o) {
                <label class="opcao">
                  <input type="checkbox" [checked]="lista(c.id).includes(o)" (change)="alternarMultipla(c.id, o)" />
                  <span>{{ o }}</span>
                </label>
              }
              @if (erros()[c.id]) { <span class="msg-erro txt-denso" role="alert">{{ erros()[c.id] }}</span> }
            </fieldset>
          }
          @case ('anexo') {
            <div class="grupo largo">
              <label class="rotulo txt-denso" [for]="'anexo-' + c.id">{{ c.rotulo }}@if (c.obrigatorio) { <span class="obrigatorio" aria-hidden="true">*</span> }</label>
              <input class="arquivo" type="file" [id]="'anexo-' + c.id" [disabled]="desabilitado()"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.csv,.txt"
                (change)="escolherArquivo(c.id, $event)" />
              <span class="dica txt-denso">PDF, imagem, planilha, Word ou texto, até 10 MB.</span>
              @if (erros()[c.id]) { <span class="msg-erro txt-denso" role="alert">{{ erros()[c.id] }}</span> }
            </div>
          }
          @default {
            <ui-campo [rotulo]="c.rotulo" [placeholder]="c.placeholder ?? ''" [obrigatorio]="c.obrigatorio"
              [desabilitado]="desabilitado()" [erro]="erros()[c.id] ?? null"
              [valor]="texto(c.id)" (valorChange)="definir(c.id, $event)" />
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .campos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--espacamento-4); min-width: 0; }
    .campos > * { min-width: 0; }
    .largo { grid-column: 1 / -1; }
    @media (max-width: 560px) { .campos { grid-template-columns: minmax(0, 1fr); } }
    .grupo { display: flex; flex-direction: column; gap: var(--espacamento-2); border: 0; margin: 0; padding: 0; min-width: 0; }
    legend, .rotulo { padding: 0; margin-bottom: var(--espacamento-1); color: var(--texto); font-weight: 500; }
    .obrigatorio { color: var(--erro); margin-left: 2px; }
    .opcao { display: flex; align-items: center; gap: var(--espacamento-2); color: var(--texto); font-size: 14px; cursor: pointer; }
    .opcao input { accent-color: var(--acao); width: 16px; height: 16px; flex: none; }
    .arquivo { max-width: 100%; color: var(--texto); font: inherit; font-size: 13px; }
    .dica { color: var(--texto-suave); }
    .msg-erro { color: var(--erro); }
  `,
})
export class FormularioRenderComponente {
  readonly campos = input.required<readonly CampoFormulario[]>()
  /** Valores por id de campo: texto, ou lista (múltipla). */
  readonly valores = model<Record<string, unknown>>({})
  /** Arquivos escolhidos, por id do campo `anexo`. */
  readonly arquivos = model<ReadonlyMap<string, File>>(new Map())
  readonly erros = input<Record<string, string>>({})
  readonly desabilitado = input(false)

  protected readonly visiveis = computed(() => camposVisiveis(this.campos(), this.valores()))

  protected texto(id: string): string {
    const v = this.valores()[id]
    return typeof v === 'string' ? v : ''
  }
  protected lista(id: string): readonly string[] {
    const v = this.valores()[id]
    return Array.isArray(v) ? (v as string[]) : []
  }
  protected opcoes(c: CampoFormulario): OpcaoSelect[] {
    return c.opcoes.map((o) => ({ valor: o, rotulo: o }))
  }
  protected definir(id: string, valor: string): void {
    this.valores.update((v) => ({ ...v, [id]: valor }))
  }
  protected alternarMultipla(id: string, opcao: string): void {
    const atual = this.lista(id)
    this.definir2(id, atual.includes(opcao) ? atual.filter((x) => x !== opcao) : [...atual, opcao])
  }
  private definir2(id: string, valor: string[]): void {
    this.valores.update((v) => ({ ...v, [id]: valor }))
  }
  protected escolherArquivo(id: string, ev: Event): void {
    const arq = (ev.target as HTMLInputElement).files?.[0]
    this.arquivos.update((m) => {
      const novo = new Map(m)
      if (arq) novo.set(id, arq); else novo.delete(id)
      return novo
    })
  }
}

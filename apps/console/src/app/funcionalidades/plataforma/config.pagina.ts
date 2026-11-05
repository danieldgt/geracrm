import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { CabecalhoTelaComponente, EsqueletoComponente, EstadoComponente } from '../../compartilhado/ui/index.js'
import { ModulosServico } from '../../nucleo/modulos.servico.js'
import { PrivacidadeComponente } from './privacidade.componente.js'
import { ConfigEmpresaComponente } from './config-empresa.componente.js'
import { ConfigModulosComponente } from './config-modulos.componente.js'
import { somenteLeitura, type EmpresaLida } from './empresa.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Configurações → aba Empresa: dados da empresa, privacidade e LGPD, módulos.
 *
 * ⚠️ Só o que é da EMPRESA mora aqui (revisão de 2026-11-05). O horário de
 * atendimento é por número e mora em Configurações → Atendimento; a equipe mora
 * em Configurações → Usuários. Antes esta tela repetia os dois (um PUT de
 * horário duplicado e uma lista de equipe só leitura) e três abas-atalho.
 * ⚠️ Gestor vê tudo em leitura; só admin salva (a API barra com 403 de qualquer forma).
 */
@Component({
  selector: 'app-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, EsqueletoComponente, EstadoComponente,
    PrivacidadeComponente, ConfigEmpresaComponente, ConfigModulosComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Empresa" subtitulo="Dados da empresa, privacidade e LGPD, módulos." />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') { <ui-esqueleto /> }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso" descricao="Você não tem permissão para ver as configurações. Peça a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as configurações" descricao="Confira a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (leitura()) {
            <p class="aviso txt-corpo" role="note">Somente administradores alteram. Você vê tudo em leitura.</p>
          }
          @if (empresa(); as emp) {
            <app-config-empresa [empresa]="emp" [leitura]="leitura()" (salvou)="atualizarEmpresa($event)" />
            <app-privacidade [empresa]="emp" [leitura]="leitura()" (salvou)="atualizarEmpresa($event)" />
          }
          <app-config-modulos [leitura]="leitura()" />
        }
      }
    </div>
  `,
  styles: `
    /* Formulário de ajustes: largura de leitura, alinhado com as abas (não centrado). */
    :host { display: block; width: 100%; max-width: var(--largura-forma); padding: var(--espacamento-6); }
    .corpo { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .corpo > * { min-width: 0; }
    .aviso { margin: 0; padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); }
  `,
})
export class ConfigPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly modulos = inject(ModulosServico)

  readonly estado = signal<Estado>('carregando')
  readonly empresa = signal<EmpresaLida | null>(null)
  readonly admin = signal<boolean | null>(null)
  readonly leitura = computed(() => somenteLeitura(this.admin()))

  ngOnInit(): void { void this.carregar() }

  atualizarEmpresa(parcial: Partial<EmpresaLida>): void {
    const atual = this.empresa()
    if (atual) this.empresa.set({ ...atual, ...parcial })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [emp, eu] = await Promise.all([
        firstValueFrom(this.http.get<EmpresaLida>('/v1/config/empresa')),
        // ⚠️ Papel só decide o que MOSTRAR; sem resposta fica em leitura (a API barra o resto).
        firstValueFrom(this.http.get<{ admin?: boolean }>('/v1/config/eu')).catch(() => ({ admin: false })),
        this.modulos.carregar(true),
      ])
      this.empresa.set(emp)
      this.admin.set(eu.admin === true)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}

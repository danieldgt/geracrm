import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import multipart from '@fastify/multipart'
import { telefoneValido } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { atorDaRequisicao } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { criarLimiteTaxa } from '../aquisicao/limite-taxa.js'
import { arquivosBucket } from '../crm/arquivos-bucket.js'
import { assinaturaConfere } from '../crm/arquivos-regras.js'
import { provedorSenhaCognito } from './provedor-senha-cognito.js'
import type { ProvedorSenha } from './provedor-senha.js'

/**
 * MEU PERFIL (D4) — a pessoa do token vê e edita o que é DELA: nome, telefone, cargo, foto e senha.
 *
 * ⚠️ O usuário vem do TOKEN (`atorDaRequisicao`), nunca de parâmetro: não existe `/perfil/:id`. Papel,
 * filial e ativo NÃO se editam aqui (isso é do cadastro de Usuários, D3, com permissão de admin).
 * ⚠️ Sessão de staff não é usuário do cliente: 403 tipificado.
 * ⚠️ A foto sobe ao bucket FORA da transação (bytes primeiro; se o banco falhar, o objeto órfão é
 * removido) e a leitura devolve URL ASSINADA curta — nunca a chave.
 */

const FOTO_MAX_BYTES = 2 * 1024 * 1024
const TTL_URL_FOTO_S = 300
const EXT_DA_FOTO: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const SENHA_MAX = 256

// Troca de senha: por usuário (quem tem o token roubado não força a senha atual por tentativa e erro).
const limiteTrocaSenha = criarLimiteTaxa({ teto: 5, janelaMs: 15 * 60_000 })

const staffSemPerfil = {
  erro: 'acesso.staff_sem_usuario',
  mensagem: 'A sessão de suporte não tem perfil próprio. Entre com o seu login para editar o perfil.',
}

export interface OpcoesRotasPerfil { readonly provedorSenha?: ProvedorSenha }

interface LinhaPerfil {
  id: string; nome: string; email: string; telefone: string | null; cargo: string | null
  foto_chave: string | null; ultimo_login_em: Date | null
}

const COLUNAS = (tx: Sql) => tx`
  SELECT id, nome, email, telefone, cargo, foto_chave, ultimo_login_em FROM usuario`

async function fotoUrl(chave: string | null): Promise<string | null> {
  const bucket = arquivosBucket()
  if (!chave || !bucket.disponivel()) return null
  try { return await bucket.urlAssinada(chave, TTL_URL_FOTO_S) } catch { return null }
}

async function paraApi(l: LinhaPerfil) {
  return {
    id: l.id, nome: l.nome, email: l.email, telefone: l.telefone, cargo: l.cargo,
    fotoUrl: await fotoUrl(l.foto_chave), ultimoLoginEm: l.ultimo_login_em,
    fotoDisponivel: arquivosBucket().disponivel(),
  }
}

/** `campos` é o mapa campo → mensagem que o console já sabe pôr no campo (422 por campo). */
const recusa = (reply: FastifyReply, status: number, erro: string, mensagem: string, campo?: string) =>
  reply.code(status).send({ erro, mensagem, ...(campo ? { campos: { [campo]: mensagem } } : {}) })

export async function rotasPerfil(app: FastifyInstance, opcoes: OpcoesRotasPerfil = {}): Promise<void> {
  const provedorSenha = opcoes.provedorSenha ?? provedorSenhaCognito(app.log)
  await app.register(multipart, { limits: { fileSize: FOTO_MAX_BYTES, files: 1, fields: 2 } })

  app.get('/v1/perfil', { preHandler: exigirTenant }, async (req, reply) => {
    const l = await req.comTenant(async (tx) => {
      const eu = await atorDaRequisicao(tx, req)
      if (!eu) return null
      const [u] = await tx<LinhaPerfil[]>`${COLUNAS(tx)} WHERE tenant_id = tenant_atual() AND id = ${eu}`
      return u ?? null
    })
    if (!l) return reply.code(403).send(staffSemPerfil)
    return reply.send(await paraApi(l))
  })

  app.patch<{ Body: { nome?: unknown; telefone?: unknown; cargo?: unknown } }>(
    '/v1/perfil', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const campos: Record<string, string> = {}
      const novos: { nome?: string; telefone?: string | null; cargo?: string | null } = {}

      if (b.nome !== undefined) {
        const nome = typeof b.nome === 'string' ? b.nome.trim() : ''
        if (!nome) campos['nome'] = 'O nome não pode ficar vazio.'
        else if (nome.length > 120) campos['nome'] = 'O nome tem no máximo 120 caracteres.'
        else novos.nome = nome
      }
      if (b.telefone !== undefined) {
        if (b.telefone === null || b.telefone === '') novos.telefone = null
        else if (typeof b.telefone === 'string' && telefoneValido(b.telefone)) novos.telefone = b.telefone.replace(/\D/g, '')
        else campos['telefone'] = 'Telefone inválido. Use DDD + número.'
      }
      if (b.cargo !== undefined) {
        const cargo = typeof b.cargo === 'string' ? b.cargo.trim() : null
        if (cargo === null) campos['cargo'] = 'Cargo inválido.'
        else if (cargo.length > 80) campos['cargo'] = 'O cargo tem no máximo 80 caracteres.'
        else novos.cargo = cargo || null
      }
      if (Object.keys(campos).length > 0) {
        return reply.code(422).send({ erro: 'perfil.invalido', mensagem: 'Confira os campos.', campos })
      }
      if (Object.keys(novos).length === 0) return recusa(reply, 422, 'perfil.vazio', 'Nada para alterar.')

      const l = await req.comTenant(async (tx) => {
        const eu = await atorDaRequisicao(tx, req)
        if (!eu) return null
        const [antes] = await tx<LinhaPerfil[]>`${COLUNAS(tx)} WHERE tenant_id = tenant_atual() AND id = ${eu}`
        const [depois] = await tx<LinhaPerfil[]>`
          UPDATE usuario SET
            nome     = ${novos.nome === undefined ? tx`nome` : novos.nome},
            telefone = ${novos.telefone === undefined ? tx`telefone` : novos.telefone},
            cargo    = ${novos.cargo === undefined ? tx`cargo` : novos.cargo}
           WHERE tenant_id = tenant_atual() AND id = ${eu}
          RETURNING id, nome, email, telefone, cargo, foto_chave, ultimo_login_em`
        const mudou = (['nome', 'telefone', 'cargo'] as const).filter((k) => novos[k] !== undefined && antes?.[k] !== depois?.[k])
        if (mudou.length > 0) {
          await auditar(tx, {
            atorId: eu, acao: 'usuario.perfil_alterado', entidade: 'usuario', entidadeId: eu,
            dados: {
              antes: Object.fromEntries(mudou.map((k) => [k, antes?.[k] ?? null])),
              depois: Object.fromEntries(mudou.map((k) => [k, depois?.[k] ?? null])),
            },
          })
        }
        return depois ?? null
      })
      if (!l) return reply.code(403).send(staffSemPerfil)
      return reply.send(await paraApi(l))
    },
  )

  // ── Foto ───────────────────────────────────────────────────────────────────
  app.put('/v1/perfil/foto', { preHandler: exigirTenant }, async (req, reply) => {
    const bucket = arquivosBucket()
    if (!bucket.disponivel()) {
      return recusa(reply, 503, 'perfil.foto_indisponivel', 'O armazenamento de arquivos não está configurado neste ambiente.')
    }
    if (!req.isMultipart()) return recusa(reply, 415, 'perfil.foto_multipart', 'Envie a foto como multipart/form-data.')

    const parte = await req.file()
    if (!parte) return recusa(reply, 422, 'perfil.foto_ausente', 'Nenhum arquivo enviado.')
    const mime = parte.mimetype.toLowerCase()
    const ext = EXT_DA_FOTO[mime]
    if (!ext) {
      parte.file.resume()
      return recusa(reply, 415, 'perfil.foto_tipo', 'Use uma imagem JPG, PNG ou WebP.')
    }
    const grande = () => recusa(reply, 413, 'perfil.foto_grande', 'A foto passa de 2 MB.')
    let bytes: Buffer
    try { bytes = await parte.toBuffer() } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return grande()
      throw e
    }
    if (parte.file.truncated) return grande()
    // ⚠️ Mime vem do cliente: o CONTEÚDO tem de ser a imagem que o tipo promete.
    if (!assinaturaConfere(mime, bytes)) {
      return recusa(reply, 415, 'perfil.foto_conteudo', 'O conteúdo do arquivo não corresponde a uma imagem do tipo informado.')
    }

    // 1) Quem sou e qual foto eu tinha — transação curta, ANTES do upload.
    const antes = await req.comTenant(async (tx) => {
      const eu = await atorDaRequisicao(tx, req)
      if (!eu) return null
      const [u] = await tx<{ foto_chave: string | null }[]>`
        SELECT foto_chave FROM usuario WHERE tenant_id = tenant_atual() AND id = ${eu}`
      return { eu, chaveAntiga: u?.foto_chave ?? null }
    })
    if (!antes) return reply.code(403).send(staffSemPerfil)

    // 2) Bytes ao bucket, FORA de transação.
    const chave = `tenant/${req.tenantId!}/perfil/${antes.eu}/${randomUUID()}.${ext}`
    await bucket.subir(chave, bytes, mime)

    // 3) Banco. Se falhar, o objeto novo é órfão e sai.
    let l: LinhaPerfil | undefined
    try {
      l = await req.comTenant(async (tx) => {
        const [u] = await tx<LinhaPerfil[]>`
          UPDATE usuario SET foto_chave = ${chave}
           WHERE tenant_id = tenant_atual() AND id = ${antes.eu}
          RETURNING id, nome, email, telefone, cargo, foto_chave, ultimo_login_em`
        await auditar(tx, {
          atorId: antes.eu, acao: 'usuario.foto_alterada', entidade: 'usuario', entidadeId: antes.eu,
          dados: { antes: { foto: antes.chaveAntiga !== null }, depois: { foto: true } },
        })
        return u
      })
    } catch (e) {
      await bucket.remover(chave).catch(() => undefined)
      throw e
    }
    // 4) A foto antiga já não é referenciada: melhor esforço.
    if (antes.chaveAntiga) await bucket.remover(antes.chaveAntiga).catch(() => undefined)
    return reply.send(await paraApi(l!))
  })

  app.delete('/v1/perfil/foto', { preHandler: exigirTenant }, async (req, reply) => {
    const r = await req.comTenant(async (tx) => {
      const eu = await atorDaRequisicao(tx, req)
      if (!eu) return null
      const [u] = await tx<{ foto_chave: string | null }[]>`
        SELECT foto_chave FROM usuario WHERE tenant_id = tenant_atual() AND id = ${eu}`
      await tx`UPDATE usuario SET foto_chave = NULL WHERE tenant_id = tenant_atual() AND id = ${eu}`
      if (u?.foto_chave) {
        await auditar(tx, {
          atorId: eu, acao: 'usuario.foto_alterada', entidade: 'usuario', entidadeId: eu,
          dados: { antes: { foto: true }, depois: { foto: false } },
        })
      }
      return { chaveAntiga: u?.foto_chave ?? null }
    })
    if (!r) return reply.code(403).send(staffSemPerfil)
    if (r.chaveAntiga) await arquivosBucket().remover(r.chaveAntiga).catch(() => undefined)
    return reply.code(204).send()
  })

  // ── Trocar senha ───────────────────────────────────────────────────────────
  app.post<{ Body: { senhaAtual?: unknown; novaSenha?: unknown } }>(
    '/v1/perfil/senha', { preHandler: exigirTenant },
    async (req, reply) => {
      const { senhaAtual, novaSenha } = req.body ?? {}
      if (typeof senhaAtual !== 'string' || !senhaAtual || senhaAtual.length > SENHA_MAX) {
        return recusa(reply, 422, 'perfil.senha_atual_obrigatoria', 'Informe a senha atual.', 'senhaAtual')
      }
      if (typeof novaSenha !== 'string' || !novaSenha || novaSenha.length > SENHA_MAX) {
        return recusa(reply, 422, 'perfil.senha_invalida', 'Informe a nova senha.', 'novaSenha')
      }
      if (novaSenha === senhaAtual) {
        return recusa(reply, 422, 'perfil.senha_igual', 'A nova senha precisa ser diferente da atual.', 'novaSenha')
      }

      const eu = await req.comTenant(async (tx) => {
        const id = await atorDaRequisicao(tx, req)
        if (!id) return null
        const [u] = await tx<{ email: string }[]>`SELECT email FROM usuario WHERE tenant_id = tenant_atual() AND id = ${id}`
        return u ? { id, email: u.email } : null
      })
      if (!eu) return reply.code(403).send(staffSemPerfil)

      if (!limiteTrocaSenha.permitir(`${req.tenantId!}:${eu.id}`, Date.now())) {
        return recusa(reply, 429, 'limite.excedido', 'Muitas tentativas. Aguarde alguns minutos.')
      }

      // Provedor FORA de transação (rede). O e-mail é o da linha do próprio usuário, não do corpo.
      const r = await provedorSenha.trocarSenha(eu.email, senhaAtual, novaSenha)
      switch (r.tipo) {
        case 'ok': {
          await req.comTenant((tx) => auditar(tx, {
            atorId: eu.id, acao: 'usuario.senha_alterada', entidade: 'usuario', entidadeId: eu.id, dados: { origem: 'perfil' },
          }))
          // Todas as sessões (inclusive esta) foram encerradas no provedor: o console manda entrar de novo.
          return reply.send({ ok: true, reloginObrigatorio: true })
        }
        case 'desafio': return recusa(reply, 422, 'perfil.senha_desafio', 'Sua conta está com a senha temporária. Use "Esqueci a senha" na tela de login para definir uma nova.')
        case 'senha_atual_errada': return recusa(reply, 422, 'perfil.senha_atual_errada', 'A senha atual está incorreta.', 'senhaAtual')
        case 'senha_invalida': return recusa(reply, 422, 'perfil.senha_invalida', r.mensagem, 'novaSenha')
        case 'limite': return recusa(reply, 429, 'limite.excedido', 'Muitas tentativas. Aguarde alguns minutos.')
        case 'indisponivel': return recusa(reply, 503, 'perfil.senha_indisponivel', 'A troca de senha está indisponível no momento.')
      }
    },
  )
}

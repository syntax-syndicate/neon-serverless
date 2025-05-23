import { Client, Connection, type ClientConfig } from 'pg';
import { Socket } from './shims/net';
import { warnIfBrowser } from './utils';

export declare interface NeonClient {
  connection: Connection & {
    stream: Socket;
    sendSCRAMClientFinalMessage: (response: any) => void;
    ssl: any;
  };
  _handleReadyForQuery: any;
  _handleAuthCleartextPassword: any;
  startup: any;
  getStartupConf: any;
  saslSession: any;
}

/**
 * The node-postgres `Client` object re-exported with minor modifications.
 * https://node-postgres.com/apis/client
 */
export class NeonClient extends Client {
  get neonConfig() {
    return this.connection.stream as Socket;
  }

  constructor(public config?: string | ClientConfig) {
    super(config);
  }

  override connect(): Promise<void>;
  override connect(callback: (err?: Error) => void): void;
  override connect(callback?: (err?: Error) => void) {
    const { neonConfig } = this;

    // disable TLS if requested
    if (neonConfig.forceDisablePgSSL) {
      this.ssl = this.connection.ssl = false;
    }

    // warn on double-encryption
    if (this.ssl && neonConfig.useSecureWebSocket) {
      console.warn(
        `SSL is enabled for both Postgres (e.g. ?sslmode=require in the connection string + forceDisablePgSSL = false) and the WebSocket tunnel (useSecureWebSocket = true). Double encryption will increase latency and CPU usage. It may be appropriate to disable SSL in the Postgres connection parameters or set forceDisablePgSSL = true.`,
      );
    }

    // throw on likely missing DB connection params
    const hasConfiguredHost =
      (typeof this.config !== 'string' && this.config?.host !== undefined) ||
      (typeof this.config !== 'string' &&
        this.config?.connectionString !== undefined) ||
      process.env.PGHOST !== undefined;
    const defaultUser = process.env.USER ?? process.env.USERNAME;
    if (
      !hasConfiguredHost &&
      this.host === 'localhost' &&
      this.user === defaultUser &&
      this.database === defaultUser &&
      this.password === null
    )
      throw new Error(
        `No database host or connection string was set, and key parameters have default values (host: localhost, user: ${defaultUser}, db: ${defaultUser}, password: null). Is an environment variable missing? Alternatively, if you intended to connect with these parameters, please set the host to 'localhost' explicitly.`,
      );
    // pipelining
    const result = super.connect(callback as any) as void | Promise<void>;

    const pipelineTLS = neonConfig.pipelineTLS && this.ssl;
    const pipelineConnect = neonConfig.pipelineConnect === 'password';

    if (!pipelineTLS && !neonConfig.pipelineConnect) return result;

    const con = this.connection;

    if (pipelineTLS) {
      // for a pipelined SSL connection, fake the SSL support message from the
      // server (the server's actual 'S' response is ignored via the
      // expectPreData argument to startTls in shims / net / index.ts)

      con.on('connect', () => con.stream.emit('data', 'S'));
      // -> prompts call to tls.connect and immediate 'sslconnect' event
    }

    if (pipelineConnect) {
      // for a pipelined startup:
      // (1) don't respond to authenticationCleartextPassword; instead, send
      // the password ahead of time
      // (2) *one time only*, don't respond to readyForQuery; instead, assume
      // it's already true

      con.removeAllListeners('authenticationCleartextPassword');
      con.removeAllListeners('readyForQuery');
      con.once('readyForQuery', () =>
        con.on('readyForQuery', this._handleReadyForQuery.bind(this)),
      );

      const connectEvent = this.ssl ? 'sslconnect' : 'connect';
      con.on(connectEvent, () => {
        if (!this.neonConfig.disableWarningInBrowsers) {
          warnIfBrowser();
        }

        this._handleAuthCleartextPassword();
        this._handleReadyForQuery();
      });
    }

    return result;
  }

  async _handleAuthSASLContinue(msg: any) {
    if (
      typeof crypto === 'undefined' ||
      crypto.subtle === undefined ||
      crypto.subtle.importKey === undefined
    ) {
      throw new Error(
        'Cannot use SASL auth when `crypto.subtle` is not defined',
      );
    }

    const cs = crypto.subtle;
    const session = this.saslSession;
    const password = this.password;
    const serverData = msg.data;

    if (
      session.message !== 'SASLInitialResponse' ||
      typeof password !== 'string' ||
      typeof serverData !== 'string'
    )
      throw new Error('SASL: protocol error');

    const attrPairs = Object.fromEntries(
      serverData.split(',').map((attrValue) => {
        if (!/^.=/.test(attrValue))
          throw new Error('SASL: Invalid attribute pair entry');
        const name = attrValue[0];
        const value = attrValue.substring(2);
        return [name, value];
      }),
    );

    const nonce = attrPairs.r;
    const salt = attrPairs.s;
    const iterationText = attrPairs.i;

    if (!nonce || !/^[!-+--~]+$/.test(nonce))
      throw new Error(
        'SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing/unprintable',
      );
    if (
      !salt ||
      !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(
        salt,
      )
    )
      throw new Error(
        'SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing/not base64',
      );
    if (!iterationText || !/^[1-9][0-9]*$/.test(iterationText))
      throw new Error(
        'SASL: SCRAM-SERVER-FIRST-MESSAGE: missing/invalid iteration count',
      );
    if (!nonce.startsWith(session.clientNonce))
      throw new Error(
        'SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce',
      );
    if (nonce.length === session.clientNonce.length)
      throw new Error(
        'SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short',
      );

    const iterations = parseInt(iterationText, 10);
    const saltBytes = Buffer.from(salt, 'base64');
    const enc = new TextEncoder();
    const passwordBytes = enc.encode(password);
    const iterHmacKey = await cs.importKey(
      'raw',
      passwordBytes,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign'],
    );
    let ui1 = new Uint8Array(
      await cs.sign(
        'HMAC',
        iterHmacKey,
        Buffer.concat([saltBytes, Buffer.from([0, 0, 0, 1])]),
      ),
    );
    let ui = ui1;
    for (var i = 0; i < iterations - 1; i++) {
      ui1 = new Uint8Array(await cs.sign('HMAC', iterHmacKey, ui1));
      ui = Buffer.from(ui.map((_, i) => ui[i] ^ ui1[i]));
    }
    const saltedPassword = ui;

    const ckHmacKey = await cs.importKey(
      'raw',
      saltedPassword,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign'],
    );
    const clientKey = new Uint8Array(
      await cs.sign('HMAC', ckHmacKey, enc.encode('Client Key')),
    );
    const storedKey = await cs.digest('SHA-256', clientKey);

    const clientFirstMessageBare = 'n=*,r=' + session.clientNonce;
    const serverFirstMessage = 'r=' + nonce + ',s=' + salt + ',i=' + iterations;
    const clientFinalMessageWithoutProof = 'c=biws,r=' + nonce;
    const authMessage =
      clientFirstMessageBare +
      ',' +
      serverFirstMessage +
      ',' +
      clientFinalMessageWithoutProof;

    const csHmacKey = await cs.importKey(
      'raw',
      storedKey,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign'],
    );
    var clientSignature = new Uint8Array(
      await cs.sign('HMAC', csHmacKey, enc.encode(authMessage)),
    );
    var clientProofBytes = Buffer.from(
      clientKey.map((_, i) => clientKey[i] ^ clientSignature[i]),
    );
    var clientProof = clientProofBytes.toString('base64');

    const skHmacKey = await cs.importKey(
      'raw',
      saltedPassword,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign'],
    );
    const serverKey = await cs.sign(
      'HMAC',
      skHmacKey,
      enc.encode('Server Key'),
    );
    const ssbHmacKey = await cs.importKey(
      'raw',
      serverKey,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign'],
    );
    var serverSignatureBytes = Buffer.from(
      await cs.sign('HMAC', ssbHmacKey, enc.encode(authMessage)),
    );

    session.message = 'SASLResponse';
    session.serverSignature = serverSignatureBytes.toString('base64');
    session.response = clientFinalMessageWithoutProof + ',p=' + clientProof;

    this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
  }
}

# openDeep

## Oracle Autonomous Database

Il backend usa Oracle Autonomous AI Database 26ai tramite mTLS e `node-oracledb`.
Non aggiungere il wallet o password al repository.

Prima di avviare l'applicazione, crea l'utente applicativo collegandoti a
Database Actions come `ADMIN`:

```sql
CREATE USER cervelletto_app IDENTIFIED BY "UNA_PASSWORD_FORTE";
GRANT CREATE SESSION, RESOURCE, UNLIMITED TABLESPACE TO cervelletto_app;
```

Variabili richieste:

```env
ORACLE_USER=cervelletto_app
ORACLE_PASSWORD=...
ORACLE_CONNECT_STRING=cervelletto_low
ORACLE_WALLET_PASSWORD=...
TNS_ADMIN=/percorso/alla/cartella/Wallet_CERVELLETTO
```

Estrai il wallet scaricato da OCI in `TNS_ADMIN`. Su Render, carica lo ZIP
come Secret File chiamato `oracle-wallet.zip`, imposta le quattro variabili
Oracle e usa `sh start-render.sh` come Start Command.
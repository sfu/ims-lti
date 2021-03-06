const crypto = require('crypto');
const http = require('http');
const url = require('url');
const uuid = require('uuid');
const should = require('should');

const xml2js = require('xml2js');
const xml_builder = require('xmlbuilder');

const hmac_sha1 = require('../src/hmac-sha1');

// Standard nonce tests
//
exports.shouldBehaveLikeNonce = newStore => {
  if (newStore == null) {
    newStore = function() {};
  }
  before(() => {
    this.store = newStore();
  });

  after(() => {
    if (this.store.redis) {
      this.store.redis.flushdb();
    }
  });

  describe('.isNew', () => {
    it('should exist', () => {
      should.exist(this.store.isNew);
    });

    it('should return false if undefined passed', done => {
      const store = newStore();
      store.isNew(undefined, undefined, function(err, valid) {
        err.should.not.equal(null);
        valid.should.equal(false);
        done();
      });
    });

    it('should return false if no nonce but timestamp', function(done) {
      const store = newStore();
      store.isNew(undefined, Math.round(Date.now() / 1000), function(
        err,
        valid
      ) {
        err.should.not.equal(null);
        valid.should.equal(false);
        done();
      });
    });

    it('should return false if nonce but no timestamp', function(done) {
      const store = newStore();
      store.isNew('1', undefined, function(err, valid) {
        err.should.not.equal(null);
        valid.should.equal(false);
        done();
      });
    });

    it('should return true for new nonces', done => {
      const store = newStore();
      const now = Math.round(Date.now() / 1000);

      const nonce_one = `true-for-new-1-${Math.random() * 1000}`;
      const nonce_two = `true-for-new-2-${Math.random() * 1000}`;
      store.isNew(nonce_one, now, function(err, valid) {
        should.not.exist(err);
        valid.should.equal(true);

        store.isNew(nonce_two, now + 1, function(err, valid) {
          should.not.exist(err);
          valid.should.equal(true);
          done();
        });
      });
    });

    it('should return false for used nonces', done => {
      const store = newStore();
      const now = Math.round(Date.now() / 1000);

      const nonce = `should-return-false-for-used-${Math.random() * 1000}`;

      store.isNew(nonce, now, function(err, valid) {
        should.not.exist(err);
        valid.should.equal(true);

        store.isNew(nonce, now + 1, function(err, valid) {
          should.exist(err);
          valid.should.equal(false);
          done();
        });
      });
    });

    it('should return true for time-relivant nonces', done => {
      const store = newStore();

      const now = Math.round(Date.now() / 1000);
      const future = now + 1 * 60;
      const past_minute = now - 1 * 60;
      const past_two_minutes = now - 2 * 60;

      const first_test = () =>
        store.isNew('tr-00', now, function(err, valid) {
          should.not.exist(err);
          valid.should.equal(true);
          second_test();
        });
      var second_test = () =>
        store.isNew('tr-11', future, function(err, valid) {
          should.not.exist(err);
          valid.should.equal(true);
          third_test();
        });
      var third_test = () =>
        store.isNew('tr-01', past_minute, function(err, valid) {
          should.not.exist(err);
          valid.should.equal(true);
          fourth_test();
        });
      var fourth_test = () =>
        store.isNew('tr-02', past_two_minutes, function(err, valid) {
          should.not.exist(err);
          valid.should.equal(true);
          done();
        });

      first_test();
    });

    it('should return false for expired nonces', done => {
      const store = newStore();

      const now = Math.round(Date.now() / 1000);
      const five_and_one_sec_old = now - 5 * 60 - 1;
      const hour_old = now - 60 * 60;

      const first_test = () =>
        store.isNew('00', five_and_one_sec_old, function(err, valid) {
          should.exist(err);
          valid.should.equal(false);
          second_test();
        });
      var second_test = () =>
        store.isNew('11', hour_old, function(err, valid) {
          should.exist(err);
          valid.should.equal(false);
          done();
        });

      first_test();
    });
  });

  describe('.setUsed', () => {
    it('should exist', () => {
      should.exist(this.store.setUsed);
    });

    it('should set nonces to used', done => {
      const store = newStore();
      const now = Math.round(Date.now() / 1000);
      store.setUsed('11', now, () =>
        store.isNew('11', now + 1, function(err, valid) {
          should.exist(err);
          valid.should.equal(false);
          done();
        })
      );
    });
  });
};

// Creates a webserver that can respond to the outcomes service
//
exports.outcomesWebServer = () => {
  const buildXmlDocument = type => {
    // Build and configure the document
    if (type == null) {
      type = 'Request';
    }
    const xmldec = {
      version: '1.0',
      encoding: 'UTF-8',
    };

    const doc = xml_builder.create('imsx_POXEnvelopeResponse', xmldec);
    doc.attribute(
      'xmlns',
      'http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0'
    );

    return doc;
  };

  const cleanupValue = value => {
    return decodeURIComponent(value.substr(1, value.length - 2));
  };

  const verifySignature = (req, body) => {
    const params = {};
    const signer = new hmac_sha1();
    const service_url = 'http://127.0.0.1:1337/service/url';

    if (typeof req.headers.authorization !== 'string') {
      return params;
    }

    for (let param of req.headers.authorization.split(',')) {
      const parts = param.split('=');
      params[decodeURIComponent(parts[0])] = cleanupValue(parts[1]);
    }

    delete params['OAuth realm'];

    const body_signature = crypto
      .createHash('sha1')
      .update(body)
      .digest('base64');
    const req_signature = signer.build_signature_raw(
      service_url,
      url.parse(service_url),
      'POST',
      params,
      'secret'
    );

    return (
      body_signature === params.oauth_body_hash &&
      req_signature === params.oauth_signature
    );
  };

  const notFoundHandler = (req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('Page not found');
  };

  const outcomeTypeNotFoundHandler = (res, type) => {
    res.writeHead(404, { 'Content-Type': 'application/xml' });

    const doc = buildXmlDocument();
    const head = doc.ele('imsx_POXHeader').ele('imsx_POXResponseHeaderInfo');

    doc.ele('imsx_POXBody');

    head.ele('imsx_version', 'V1.0');
    head.ele('imsx_messageIdentifier', uuid.v4());

    const sub_head = head.ele('imsx_statusInfo');
    sub_head.ele('imsx_codeMajor', 'unsupported');
    sub_head.ele('imsx_severity', 'status');
    sub_head.ele('imsx_description', `${type} is not supported`);
    sub_head.ele('imsx_messageRefIdentifier', uuid.v4());
    sub_head.ele('imsx_operationRefIdentifier', type);

    res.end(doc.end() + '\n');
  };

  const invalidSignatureError = res => {
    res.writeHead(403, { 'Content-Type': 'application/xml' });

    const doc = buildXmlDocument();
    const head = doc.ele('imsx_POXHeader').ele('imsx_POXResponseHeaderInfo');

    doc.ele('imsx_POXBody');

    head.ele('imsx_version', 'V1.0');
    head.ele('imsx_messageIdentifier', uuid.v4());

    const sub_head = head.ele('imsx_statusInfo');
    sub_head.ele('imsx_codeMajor', 'failure');
    sub_head.ele('imsx_severity', 'signature');
    sub_head.ele('imsx_description', 'The signature provided is not valid');
    sub_head.ele('imsx_messageRefIdentifier', uuid.v4());
    sub_head.ele('imsx_operationRefIdentifier', 'signature');

    res.end(doc.end() + '\n');
  };

  const invalidScoreError = res => {
    res.writeHead(403, { 'Content-Type': 'application/xml' });

    const doc = buildXmlDocument();
    const head = doc.ele('imsx_POXHeader').ele('imsx_POXResponseHeaderInfo');

    doc.ele('imsx_POXBody');

    head.ele('imsx_version', 'V1.0');
    head.ele('imsx_messageIdentifier', uuid.v4());

    const sub_head = head.ele('imsx_statusInfo');
    sub_head.ele('imsx_codeMajor', 'failure');
    sub_head.ele('imsx_severity', 'score');
    sub_head.ele('imsx_description', 'The score provided is not valid');
    sub_head.ele('imsx_messageRefIdentifier', uuid.v4());
    sub_head.ele('imsx_operationRefIdentifier', 'score');

    res.end(doc.end() + '\n');
  };

  const validScoreResponse = (res, id, score) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });

    const doc = buildXmlDocument();
    const head = doc.ele('imsx_POXHeader').ele('imsx_POXResponseHeaderInfo');

    doc.ele('imsx_POXBody').ele('replaceResultResponse');

    head.ele('imsx_version', 'V1.0');
    head.ele('imsx_messageIdentifier', uuid.v4());

    const sub_head = head.ele('imsx_statusInfo');
    sub_head.ele('imsx_codeMajor', 'success');
    sub_head.ele('imsx_severity', 'status');
    sub_head.ele('imsx_description', `The score for ${id} is now ${score}`);
    sub_head.ele('imsx_messageRefIdentifier', uuid.v4());
    sub_head.ele('imsx_operationRefIdentifier', 'replaceResult');

    res.end(doc.end() + '\n');
  };

  const validReadResponse = res => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });

    const doc = buildXmlDocument();
    const head = doc.ele('imsx_POXHeader').ele('imsx_POXResponseHeaderInfo');

    const result = doc
      .ele('imsx_POXBody')
      .ele('readResultResponse')
      .ele('result')
      .ele('resultScore');
    result.ele('language', 'en');
    result.ele('textString', '.5');

    head.ele('imsx_version', 'V1.0');
    head.ele('imsx_messageIdentifier', uuid.v4());

    const sub_head = head.ele('imsx_statusInfo');
    sub_head.ele('imsx_codeMajor', 'success');
    sub_head.ele('imsx_severity', 'status');
    sub_head.ele('imsx_description', 'Result read');
    sub_head.ele('imsx_messageRefIdentifier', uuid.v4());
    sub_head.ele('imsx_operationRefIdentifier', 'readResult');

    res.end(doc.end() + '\n');
  };

  const validDeleteResponse = res => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });

    const doc = buildXmlDocument();
    const head = doc.ele('imsx_POXHeader').ele('imsx_POXResponseHeaderInfo');

    doc.ele('imsx_POXBody').ele('deleteResultResponse');

    head.ele('imsx_version', 'V1.0');
    head.ele('imsx_messageIdentifier', uuid.v4());

    const sub_head = head.ele('imsx_statusInfo');
    sub_head.ele('imsx_codeMajor', 'success');
    sub_head.ele('imsx_severity', 'status');
    sub_head.ele('imsx_description', 'Result deleted');
    sub_head.ele('imsx_messageRefIdentifier', uuid.v4());
    sub_head.ele('imsx_operationRefIdentifier', 'deleteResult');

    res.end(doc.end() + '\n');
  };

  const verifyDoc = doc => {
    doc.should.be.an.Object;
    doc.should.have.property('sourcedGUID').with.lengthOf(1);
    doc.sourcedGUID[0].should.be.an.Object;
    doc.sourcedGUID[0].should.have.property('sourcedId').with.lengthOf(1);
    doc.sourcedGUID[0].sourcedId[0].should.be.a.String;
  };

  const outcomesHandler = (req, res) => {
    let body = '';

    req.on('data', buffer => {
      body += buffer.toString('utf8');
    });

    req.on('end', () => {
      if (!verifySignature(req, body)) {
        return invalidSignatureError(res);
      }

      xml2js.parseString(body, { trim: true }, (err, result) => {
        const result_body =
          result &&
          result.imsx_POXEnvelopeRequest &&
          result.imsx_POXEnvelopeRequest.imsx_POXBody
            ? result.imsx_POXEnvelopeRequest.imsx_POXBody[0]
            : undefined;
        const result_type = Object.keys(result_body || {})[0];

        switch (result_type) {
          case 'replaceResultRequest':
            verifyDoc(result_body.replaceResultRequest[0].resultRecord[0]);

            // As ugly as this may be this is one of the most effective XML parsers for node... yeah...
            var score = parseFloat(
              result_body.replaceResultRequest[0].resultRecord[0].result[0]
                .resultScore[0].textString[0]
            );

            if (score < 0 || score > 1) {
              return invalidScoreError(res);
            } else {
              return validScoreResponse(res, null, score);
            }

          case 'readResultRequest':
            verifyDoc(result_body.readResultRequest[0].resultRecord[0]);

            return validReadResponse(res);

          case 'deleteResultRequest':
            verifyDoc(result_body.deleteResultRequest[0].resultRecord[0]);

            return validDeleteResponse(res);

          default:
            return outcomeTypeNotFoundHandler(
              res,
              result_type || 'undefinedRequest'
            );
        }
      });
    });
  };

  return http.createServer((req, res) => {
    const path = url.parse(req.url);
    const handler =
      path.pathname === '/service/url' ? outcomesHandler : notFoundHandler;

    return handler(req, res);
  });
};

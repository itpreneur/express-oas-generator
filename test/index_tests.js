'use strict';

const express = require('express');
const request = require('request');
const assert = require('assert');
const bodyParser = require('body-parser');
const generator = require('../index.js');


const MS_TO_STARTUP = 2000;
const port = 8888;
const ERROR_RESPONSE_CODE = 500;
const BASE_PATH = '/api/v1';
const ERROR_PATH = '/error';
const PLAIN_TEXT_RESPONSE = 'whatever';

it('WHEN patch function is provided THEN it is applied to spec', done => {
  const path = '/hello';
  const newTitle = 'New title';
  const newValue = 2;
  const app = express();
  generator.init(app, function(spec) {
    spec.info.title = newTitle;
    if (spec.paths[path] && spec.paths[path].get.parameters[0]) {
      spec.paths[path].get.parameters[0].example = newValue;
    }
    return spec;
  });
  app.get(path, (req, res, next) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(PLAIN_TEXT_RESPONSE);
    return next();
  });
  app.set('port', port);
  const server = app.listen(app.get('port'), function() {
    setTimeout(() => {
      request.get(`http://localhost:${port}${path}?a=1`, () => {
        const spec = generator.getSpec();
        expect(spec.info.title).toBe(newTitle);
        expect(spec.paths[path].get.parameters[0].example).toBe(newValue);
        server.close();
        done();
      });
    }, MS_TO_STARTUP);
  });
});

describe('index.js', () => {

  let server;
  const middleware = (req, res, next) => {
    res.status(200).send({ result: 'OK' });
    return next();
  };
  const errorMiddleware = (error, req, res, next) => {
    if (!error) {
      return next();
    }
    res.status(ERROR_RESPONSE_CODE).send(error);
    return undefined;
  };

  beforeAll(done => {
    const app = express();
    generator.init(app, {});

    app.use(bodyParser.json({}));
    app.get('/hello', (req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      return res.end(PLAIN_TEXT_RESPONSE);
    });
    app.post('/hello2', (req, res, next) => {
      res.setHeader('Content-Type', 'application/json');
      res.send({key: 'secret'});
      next();
    });
    app.use('/should_not_be_handled', middleware);
    let router = express.Router();
    router.get('/success/:param/router', middleware);
    router.get('/success-no-param', middleware);
    router.get(ERROR_PATH, (req, res, next) => next({ error: 'error' }));
    app.use(BASE_PATH, router);
    app.use(errorMiddleware);
    app.set('port', port);
    server = app.listen(app.get('port'));
    setTimeout(done, MS_TO_STARTUP);
  });

  beforeEach(done => {
    let spec = generator.getSpec();
    expect(Object.keys(spec.paths).length).toBe(5);
    request.get(`http://localhost:${port}/api-spec`, (error, res) => {
      expect(JSON.parse(res.body)).toEqual(spec);
      done();
    });
  });

  afterAll(() => {
    // console.info(JSON.stringify(generator.getSpec(), null, 2));
    server.close();
  });

  it('WHEN making GET request to endpoint returning plain text THEN schema filled properly', done => {
    const path = '/hello';
    request.get(`http://localhost:${port}${path}`, () => {
      const method = generator.getSpec().paths[path].get;
      expect(method.produces).toEqual(['text/plain']);
      expect(method.summary).toEqual(path);
      expect(method.responses[200].schema.type).toEqual('string');
      expect(method.responses[200].schema.example).toEqual(PLAIN_TEXT_RESPONSE);
      done();
    });
  });

  it('WHEN making POST request to routerless endpoint THEN body is documented', done => {
    const path = '/hello2';
    const postData = {'foo': 'bar'};
    request({
      url: `http://localhost:${port}${path}`,
      method: 'POST',
      headers: {'content-type' : 'application/json'},
      body: JSON.stringify(postData)
    }, () => {
      const method = generator.getSpec().paths[path].post;
      ['consumes', 'produces'].forEach(el =>
        expect(method[el]).toEqual(['application/json'])
      );
      expect(method.summary).toEqual(path);
      const bodyParam = method.parameters[0];
      expect(bodyParam.in).toEqual('body');
      expect(bodyParam.schema.properties.foo.type).toEqual('string');
      done();
    });
  });

  it('WHEN making success requests THEN path should be filled with request and response schema', done => {
    const param = 1;
    const path = `${BASE_PATH}/success/${param}/router`;
    request.get(`http://localhost:${port}${path}`, () => {
      const spec = generator.getSpec();
      expect(spec.host).toEqual(`localhost:${port}`);
      expect(spec.schemes).toEqual(['http']);

      const expressPath = path.replace('/' + param, '/{param}');
      const specPath = spec.paths[expressPath];
      expect(specPath).toBeDefined();
      expect(Object.keys(specPath)).toEqual(['get']);
      expect(specPath.get.parameters.length).toBe(1);

      const method = specPath.get;
      ['consumes', 'produces'].forEach(el =>
        expect(method[el]).toEqual(['application/json'])
      );

      const bodyParam = method.parameters[0];
      expect(bodyParam.name).toBe('param');
      expect(bodyParam.in).toBe('path');
      expect(bodyParam.type).toBe('integer');
      expect(bodyParam.required).toBeTruthy();
      expect(bodyParam.example).toBe(param);


      const responses = method.responses;
      expect(Object.keys(responses)).toEqual(['200']);
      const schema = responses['200'].schema;
      expect(schema.type).toBe('object');
      expect(schema.properties.result.type).toBe('string');
      expect(schema.properties.result.example).toBe('OK');

      done();
    });
  });

  it('WHEN getting request with Authorization and X-* headers THEN security parts should be filled', done => {
    const path = `${BASE_PATH}/success-no-param`;
    const options = {
      url: `http://localhost:${port}/${path}`,
      headers: {
        'Authorization': 'Bearer 123',
        'X-Header': '123'
      }
    };
    request(options, () => {
      const spec = generator.getSpec();
      const specPath = spec.paths[path].get;
      expect(specPath.security.map(s => Object.keys(s)[0])).toEqual(Object.keys(options.headers).map(h => h.toLowerCase()));
      expect(Object.keys(spec.securityDefinitions)).toEqual(Object.keys(options.headers).map(h => h.toLowerCase()));
      for (let def in spec.securityDefinitions) {
        expect(spec.securityDefinitions[def]).toEqual({
          'type': 'apiKey',
          'name': def.toLowerCase(),
          'in': 'header'
        });
      }
      done();
    });
  });

  it('WHEN making error request THEN error response should be added to path', done => {
    const path = BASE_PATH + ERROR_PATH;
    request.get(`http://localhost:${port}${path}`, () => {
      const response = generator.getSpec().paths[path].get.responses[ERROR_RESPONSE_CODE];
      expect(response).toBeDefined();
      expect(response.schema.properties.error).toBeDefined();
      done();
    });
  });

});

it('WHEN package json includes baseUrlPath THEN spec description is updated', done => {
  generator.setPackageInfoPath('test/specs/withBaseUrlPath');
  generator.init(express(), {});

  setTimeout(() => {
    const spec = generator.getSpec();
    assert.equal(spec.info.description.indexOf(', base url :') > 0, true);
    done();
  }, 1001);
});


it('WHEN package json does not include baseUrlPath THEN spec description is not updated', done => {
  generator.setPackageInfoPath('test/specs/withoutBaseUrlPath');
  generator.init(express(), {});

  setTimeout(() => {
    const spec = generator.getSpec();
    assert.equal(spec.info.description.indexOf(', base url :') > 0, false);
    done();
  }, 1001);
});
/*global describe, it, expect, beforeAll, beforeEach, afterAll, afterEach*/
const underTest = require('../src/commands/create'),
	limits = require('../src/util/limits.json'),
	tmppath = require('../src/util/tmppath'),
	destroyObjects = require('./util/destroy-objects'),
	callApi = require('../src/util/call-api'),
	templateFile = require('../src/util/template-file'),
	ArrayLogger = require('../src/util/array-logger'),
	shell = require('shelljs'),
	fs = require('fs'),
	fsPromise = require('../src/util/fs-promise'),
	retriableWrap = require('../src/util/retriable-wrap'),
	path = require('path'),
	os = require('os'),
	aws = require('aws-sdk'),
	pollForLogEvents = require('./util/poll-for-log-events'),
	awsRegion = require('./util/test-aws-region');
describe('create', () => {
	'use strict';
	let workingdir, testRunName, iam, lambda, newObjects, config, logs, apiGatewayPromise;
	const createFromDir = function (dir, logger) {
			if (!shell.test('-e', workingdir)) {
				shell.mkdir('-p', workingdir);
			}
			shell.cp('-r',
				path.join(__dirname, 'test-projects/', (dir || 'hello-world')) + '/*',
				workingdir
			);
			if (shell.test('-e', path.join(__dirname, 'test-projects/', (dir || 'hello-world'), '.npmrc'))) {
				shell.cp(
					path.join(__dirname, 'test-projects/', (dir || 'hello-world'), '.npmrc'),
					workingdir
				);
			}
			return underTest(config, logger)
			.then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				newObjects.restApi = (result.api && result.api.id) || (result.proxyApi && result.proxyApi.id);
				return result;
			});
		},
		getLambdaConfiguration = function () {
			return lambda.getFunctionConfiguration({ FunctionName: testRunName }).promise();
		};
	beforeEach(() => {
		workingdir = tmppath();
		testRunName = 'test' + Date.now();
		iam = new aws.IAM();
		lambda = new aws.Lambda({ region: awsRegion });
		apiGatewayPromise = retriableWrap(new aws.APIGateway({ region: awsRegion }));
		logs = new aws.CloudWatchLogs({ region: awsRegion });
		newObjects = { workingdir: workingdir };
		config = { name: testRunName, region: awsRegion, source: workingdir, handler: 'main.handler' };
	});
	afterEach(done => {
		destroyObjects(newObjects).then(done, done.fail);
	});
	describe('config validation', () => {
		it('fails if the source folder is same as os tmp folder', done => {
			config.source = os.tmpdir();
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('Source directory is the Node temp directory. Cowardly refusing to fill up disk with recursive copy.'))
			.then(done);
		});
		it('fails if name is not given either as an option or package.json name', done => {
			shell.mkdir(workingdir);
			shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
			fs.writeFileSync(path.join(workingdir, 'package.json'), '{"name": ""}', 'utf8');
			config.name = undefined;
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('project name is missing. please specify with --name or in package.json'))
			.then(done);
		});
		it('fails if the region is not given', done => {
			config.region = undefined;
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('AWS region is missing. please specify with --region'))
			.then(done);
		});
		it('fails if the handler is not given', done => {
			config.handler = undefined;
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('Lambda handler is missing. please specify with --handler'))
			.then(done);
		});
		it('fails if the handler does not contain a dot', done => {
			config.handler = 'api';
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('Lambda handler function not specified. Please specify with --handler module.function'))
			.then(done);
		});
		it('fails if both handler and api module are provided', done => {
			config.handler = 'main.handler';
			config['api-module'] = 'main';
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('incompatible arguments: cannot specify handler and api-module at the same time.'))
			.then(done);
		});
		it('fails if deploy-proxy-api is specified but handler is not', done => {
			config['deploy-proxy-api'] = true;
			config.handler = undefined;
			config['api-module'] = 'abc';
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('deploy-proxy-api requires a handler. please specify with --handler'))
			.then(done);
		});
		it('fails if subnetIds is specified without securityGroupIds', done => {
			config['subnet-ids'] = 'subnet-abcdef12';
			config['security-group-ids'] = null;
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('VPC access requires at least one security group id *and* one subnet id'))
			.then(done);
		});
		it('fails if securityGroupIds is specified without subnetIds', done => {
			config['subnet-ids'] = null;
			config['security-group-ids'] = 'sg-12341234';
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('VPC access requires at least one security group id *and* one subnet id'))
			.then(done);
		});
		it('fails if the api module contains an extension', done => {
			config.handler = undefined;
			config['api-module'] = 'api.js';
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('API module must be a module name, without the file extension or function name'))
			.then(done);
		});
		it('fails if claudia.json already exists in the source folder', done => {
			shell.mkdir(workingdir);
			fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('claudia.json already exists in the source folder'))
			.then(done);
		});
		it('works if claudia.json already exists in the source folder but alternative config provided', done => {
			shell.mkdir(workingdir);
			shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
			fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
			shell.cd(workingdir);
			config.config = 'lambda.json';
			underTest(config)
			.then(done, done.fail);
		});
		it('fails if the alternative config is provided but the file already exists', done => {
			shell.mkdir(workingdir);
			shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
			fs.writeFileSync(path.join(workingdir, 'lambda.json'), '{}', 'utf8');
			shell.cd(workingdir);
			config.config = 'lambda.json';
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('lambda.json already exists'))
			.then(done);
		});
		it('checks the current folder if the source parameter is not defined', done => {
			shell.mkdir(workingdir);
			shell.cd(workingdir);
			fs.writeFileSync(path.join('claudia.json'), '{}', 'utf8');
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('claudia.json already exists in the source folder'))
			.then(done);
		});
		it('fails if package.json does not exist in the target folder', done => {
			shell.mkdir(workingdir);
			shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
			shell.rm(path.join(workingdir, 'package.json'));
			underTest(config)
			.then(done.fail, message => expect(message).toEqual('package.json does not exist in the source folder'))
			.then(done);
		});
		it('fails if local dependencies and optional dependencies are mixed', done => {
			config['use-local-dependencies'] = true;
			config['optional-dependencies'] = false;
			createFromDir('hello-world')
			.then(done.fail, message => expect(message).toEqual('incompatible arguments --use-local-dependencies and --no-optional-dependencies'))
			.then(done);
		});
		it('validates the package before creating the role or the function', done => {
			createFromDir('echo-dependency-problem')
			.then(() => done.fail('create succeeded'), reason => {
				expect(reason).toEqual('cannot require ./main after clean installation. Check your dependencies.');
			})
			.then(() => iam.getRole({ RoleName: `${testRunName}-executor` }).promise())
			.then(() => done.fail('iam role was created'), () => {})
			.then(getLambdaConfiguration)
			.then(() => done.fail('function was created'), done);
		});
	});

	describe('role management', () => {
		it('creates the IAM role for the lambda', done => {
			createFromDir('hello-world')
			.then(() => iam.getRole({ RoleName: `${testRunName}-executor` }).promise())
			.then(role => expect(role.Role.RoleName).toEqual(`${testRunName}-executor`))
			.then(done, done.fail);
		});
		describe('when a role is provided', () => {
			let createdRole, roleName, logger;
			const invoke = function () {
				return lambda.invoke({
					FunctionName: testRunName,
					InvocationType: 'RequestResponse'
				}).promise();
			};
			beforeEach(done => {
				roleName = `${testRunName}-manual`;
				logger = new ArrayLogger();
				fsPromise.readFileAsync(templateFile('lambda-exector-policy.json'), 'utf8')
				.then(lambdaRolePolicy => {
					return iam.createRole({
						RoleName: roleName,
						AssumeRolePolicyDocument: lambdaRolePolicy
					}).promise();
				})
				.then(result => {
					createdRole = result.Role;
				})
				.then(done, done.fail);
			});
			it('creates the function using the provided role by name', done => {
				config.role = `${testRunName}-manual`;
				createFromDir('hello-world', logger)
				.then(createResult => expect(createResult.lambda.role).toEqual(`${testRunName}-manual`))
				.then(getLambdaConfiguration)
				.then(lambdaMetadata => expect(lambdaMetadata.Role).toEqual(createdRole.Arn))
				.then(invoke)
				.then(result => JSON.parse(result.Payload))
				.then(payload => expect(payload).toEqual('hello world'))
				.then(() => iam.getRole({ RoleName: `${testRunName}-executor` }).promise())
				.then(() => done.fail('Executor role was created'), done);
			});
			it('does not set up any additional cloudwatch policies if --role is provided', done => {
				config.role = `${testRunName}-manual`;
				createFromDir('hello-world', logger)
				.then(() => iam.listRolePolicies({ RoleName: roleName }).promise())
				.then(result => expect(result.PolicyNames).toEqual([]))
				.then(done, done.fail);
			});
			it('creates the function using the provided role by ARN, without any IAM calls', done => {
				config.role = createdRole.Arn;
				createFromDir('hello-world', logger)
				.then(() => {
					newObjects.lambdaRole = false;
					expect(logger.getApiCallLogForService('iam', true)).toEqual([]);
				})
				.then(getLambdaConfiguration)
				.then(lambdaMetadata => expect(lambdaMetadata.Role).toEqual(createdRole.Arn))
				.then(invoke)
				.then(result => JSON.parse(result.Payload))
				.then(payload => expect(payload).toEqual('hello world'))
				.then(() => iam.listRolePolicies({ RoleName: roleName }).promise())
				.then(result => expect(result.PolicyNames).toEqual([]))
				.then(done, done.fail);
			});
		});
		it('allows the function to log to cloudwatch', done => {
			logs.createLogGroup({ logGroupName: `${testRunName}-group` }).promise()
			.then(() => {
				newObjects.logGroup = `${testRunName}-group`;
				return logs.createLogStream({ logGroupName: `${testRunName}-group`, logStreamName: `${testRunName}-stream` }).promise();
			})
			.then(() => createFromDir('cloudwatch-log'))
			.then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					Payload: JSON.stringify({
						region: awsRegion,
						stream: `${testRunName}-stream`,
						group: `${testRunName}-group`,
						message: `hello ${testRunName}`
					})
				}).promise();
			})
			.then(() => pollForLogEvents(`${testRunName}-group`, `hello ${testRunName}`, awsRegion))
			.then(events => {
				expect(events.length).toEqual(1);
				expect(events[0].message).toEqual(`hello ${testRunName}`);
			})
			.then(done, done.fail);
		});
		it('allows function to call itself if --allow-recursion is specified', done => {
			config['allow-recursion'] = true;
			createFromDir('hello-world')
			.then(() => iam.listRolePolicies({ RoleName: `${testRunName}-executor` }).promise())
			.then(result => expect(result.PolicyNames).toEqual(['log-writer', 'recursive-execution']))
			.then(() => iam.getRolePolicy({ PolicyName: 'recursive-execution', RoleName: `${testRunName}-executor` }).promise())
			.then(policy => {
				expect(JSON.parse(decodeURIComponent(policy.PolicyDocument))).toEqual(
					{
						'Version': '2012-10-17',
						'Statement': [{
							'Sid': 'InvokePermission',
							'Effect': 'Allow',
							'Action': [
								'lambda:InvokeFunction'
							],
							'Resource': `arn:aws:lambda:${awsRegion}:*:function:${testRunName}`
						}]
					});
			})
			.then(done, e => {
				console.log(e);
				done.fail();
			});
		});
		describe('when VPC access is desired', () => {
			let vpc, subnet, securityGroup;
			const securityGroupName = `${testRunName}SecurityGroup`,
				CidrBlock = '10.0.0.0/16',
				ec2 = new aws.EC2({ region: awsRegion });
			beforeAll(done => {
				ec2.createVpc({ CidrBlock: CidrBlock }).promise()
				.then(vpcData => {
					vpc = vpcData.Vpc;
					return ec2.createSubnet({CidrBlock: CidrBlock, VpcId: vpc.VpcId}).promise();
				})
				.then(subnetData => {
					subnet = subnetData.Subnet;
					return ec2.createSecurityGroup({ GroupName: securityGroupName, Description: 'Temporary testing group', VpcId: vpc.VpcId }).promise();
				})
				.then(securityGroupData => {
					securityGroup = securityGroupData;
				})
				.then(done, done.fail);
			});
			afterAll(done => {
				ec2.deleteSubnet({ SubnetId: subnet.SubnetId }).promise()
				.then(() => ec2.deleteSecurityGroup({ GroupId: securityGroup.GroupId }).promise())
				.then(() =>  ec2.deleteVpc({ VpcId: vpc.VpcId }).promise())
				.then(done)
				.catch(done.fail);
			});
			it('adds subnet and security group membership to the function', done => {
				config['security-group-ids'] = securityGroup.GroupId;
				config['subnet-ids'] = subnet.SubnetId;
				createFromDir('hello-world')
				.then(getLambdaConfiguration)
				.then(result => {
					expect(result.VpcConfig.SecurityGroupIds[0]).toEqual(securityGroup.GroupId);
					expect(result.VpcConfig.SubnetIds[0]).toEqual(subnet.SubnetId);
				})
				.then(done, e => {
					console.log(e);
					done.fail();
				});
			});
			it('adds VPC Access IAM role', done => {
				config['security-group-ids'] = securityGroup.GroupId;
				config['subnet-ids'] = subnet.SubnetId;
				createFromDir('hello-world')
				.then(() => iam.listRolePolicies({ RoleName: `${testRunName}-executor` }).promise())
				.then(result => expect(result.PolicyNames).toEqual(['log-writer', 'vpc-access-execution']))
				.then(() => iam.getRolePolicy({ PolicyName: 'vpc-access-execution', RoleName: `${testRunName}-executor` }).promise())
				.then(policy => {
					expect(JSON.parse(decodeURIComponent(policy.PolicyDocument))).toEqual(
						{
							'Version': '2012-10-17',
							'Statement': [{
								'Sid': 'VPCAccessExecutionPermission',
								'Effect': 'Allow',
								'Action': [
									'logs:CreateLogGroup',
									'logs:CreateLogStream',
									'logs:PutLogEvents',
									'ec2:CreateNetworkInterface',
									'ec2:DeleteNetworkInterface',
									'ec2:DescribeNetworkInterfaces'
								],
								'Resource': '*'
							}]
						});
				})
				.then(done, e => {
					console.log(e);
					done.fail();
				});
			});
		});

		it('loads additional policies from a policies directory recursively, if provided', done => {
			const sesPolicy = {
					'Version': '2012-10-17',
					'Statement': [{
						'Effect': 'Allow',
						'Action': [
							'ses:SendEmail'
						],
						'Resource': ['*']
					}]
				},
				policiesDir = path.join(workingdir, 'policies');
			shell.mkdir('-p', path.join(policiesDir, 'subdir'));
			fs.writeFileSync(path.join(workingdir, 'policies', 'subdir', 'ses policy.json'), JSON.stringify(sesPolicy), 'utf8');
			config.policies = policiesDir;
			createFromDir('hello-world')
			.then(() => iam.listRolePolicies({ RoleName: `${testRunName}-executor` }).promise())
			.then(result => expect(result.PolicyNames).toEqual(['log-writer', 'ses-policy-json']))
			.then(() => iam.getRolePolicy({ PolicyName: 'ses-policy-json', RoleName: `${testRunName}-executor` }).promise())
			.then(policy => expect(JSON.parse(decodeURIComponent(policy.PolicyDocument))).toEqual(sesPolicy))
			.then(done, done.fail);
		});
		it('loads additional policies from a file pattern, if provided', done => {
			const sesPolicy = {
					'Version': '2012-10-17',
					'Statement': [{
						'Effect': 'Allow',
						'Action': [
							'ses:SendEmail'
						],
						'Resource': ['*']
					}]
				},
				policiesDir = path.join(workingdir, 'policies');
			shell.mkdir('-p', path.join(policiesDir));
			fs.writeFileSync(path.join(workingdir, 'policies', 'ses policy.json'), JSON.stringify(sesPolicy), 'utf8');
			config.policies = path.join(policiesDir, '*.json');
			createFromDir('hello-world')
			.then(() =>  iam.listRolePolicies({ RoleName: `${testRunName}-executor` }).promise())
			.then(result => expect(result.PolicyNames).toEqual(['log-writer', 'ses-policy-json']))
			.then(() => iam.getRolePolicy({ PolicyName: 'ses-policy-json', RoleName: `${testRunName}-executor` }).promise())
			.then(policy => expect(JSON.parse(decodeURIComponent(policy.PolicyDocument))).toEqual(sesPolicy))
			.then(done, done.fail);
		});
		it('fails if the policies argument does not match any files', done => {
			config.policies = path.join('*.NOT');
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual('no files match additional policies (*.NOT)'))
			.then(() => iam.getRole({ RoleName: `${testRunName}-executor` }).promise())
			.then(() => done.fail('iam role was created'), () => {})
			.then(getLambdaConfiguration)
			.then(() => done.fail('function was created'), done);
		});
	});
	describe('runtime support', () => {
		it('creates node 6.10 deployments by default', done => {
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Runtime).toEqual('nodejs6.10'))
			.then(done, done.fail);
		});
		it('can create nodejs4.3 when requested', done => {
			config.runtime = 'nodejs4.3';
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Runtime).toEqual('nodejs4.3'))
			.then(done, done.fail);
		});
		it('can create nodejs4.3-edge deployments using the --runtime argument', done => {
			config.runtime = 'nodejs4.3-edge';
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Runtime).toEqual('nodejs4.3-edge'))
			.then(done, done.fail);
		});
	});
	describe('memory option support', () => {
		it(`fails if memory value is < ${limits.LAMBDA.MEMORY.MIN}`, done => {
			config.memory = limits.LAMBDA.MEMORY.MIN - 64;
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual(`the memory value provided must be greater than or equal to ${limits.LAMBDA.MEMORY.MIN}`))
			.then(done, done.fail);
		});
		it('fails if memory value is 0', done => {
			config.memory = 0;
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual(`the memory value provided must be greater than or equal to ${limits.LAMBDA.MEMORY.MIN}`))
			.then(done, done.fail);
		});
		it(`fails if memory value is > ${limits.LAMBDA.MEMORY.MAX}`, done => {
			config.memory = limits.LAMBDA.MEMORY.MAX + 64;
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual(`the memory value provided must be less than or equal to ${limits.LAMBDA.MEMORY.MAX}`))
			.then(done, done.fail);
		});
		it('fails if memory value is not a multiple of 64', done => {
			config.memory = limits.LAMBDA.MEMORY.MIN + 2;
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual('the memory value provided must be a multiple of 64'))
			.then(done, done.fail);
		});
		it(`creates memory size of ${limits.LAMBDA.MEMORY.MIN} MB by default`, done => {
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.MemorySize).toEqual(limits.LAMBDA.MEMORY.MIN))
			.then(done, done.fail);
		});
		it('can specify memory size using the --memory argument', done => {
			config.memory = limits.LAMBDA.MEMORY.MAX;
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.MemorySize).toEqual(limits.LAMBDA.MEMORY.MAX))
			.then(done, done.fail);
		});
	});
	describe('timeout option support', () => {
		it('fails if timeout value is < 1', done => {
			config.timeout = 0;
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual('the timeout value provided must be greater than or equal to 1'))
			.then(done, done.fail);
		});
		it('fails if timeout value is > 300', done => {
			config.timeout = 301;
			createFromDir('hello-world')
			.then(done.fail, error => expect(error).toEqual('the timeout value provided must be less than or equal to 300'))
			.then(done, done.fail);
		});
		it('creates timeout of 3 seconds by default', done => {
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Timeout).toEqual(3))
			.then(done, done.fail);
		});
		it('can specify timeout using the --timeout argument', done => {
			config.timeout = 300;
			createFromDir('hello-world')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Timeout).toEqual(300))
			.then(done, done.fail);
		});
	});
	describe('creating the function', () => {
		it('wires up the handler so the function is executable', done => {
			createFromDir('echo')
			.then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					InvocationType: 'RequestResponse',
					Payload: JSON.stringify({
						message: `hello ${testRunName}`
					})
				}).promise();
			})
			.then(result => expect(JSON.parse(result.Payload)).toEqual({ message: `hello ${testRunName}` }))
			.then(done, done.fail);
		});
		it('wires up handlers from subfolders', done => {
			shell.mkdir('-p', path.join(workingdir, 'subdir'));
			shell.cp('-r', 'spec/test-projects/echo/*', workingdir);
			shell.mv(path.join(workingdir, 'main.js'), path.join(workingdir, 'subdir', 'mainfromsub.js'));
			config.handler = 'subdir/mainfromsub.handler';
			shell.cd(workingdir);
			underTest(config)
			.then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					InvocationType: 'RequestResponse',
					Payload: JSON.stringify({
						message: `hello ${testRunName}`
					})
				}).promise();
			})
			.then(result => expect(JSON.parse(result.Payload)).toEqual({ message: `hello ${testRunName}` }))
			.then(done, done.fail);
		});

		it('returns an object containing the new claudia configuration', done => {
			createFromDir('hello-world')
			.then(creationResult => {
				expect(creationResult.lambda).toEqual({
					role: `${testRunName}-executor`,
					region: awsRegion,
					name: testRunName
				});
			})
			.then(done, done.fail);
		});
		it('uses the name from package.json if --name is not specified', done => {
			config.name = undefined;
			createFromDir('hello-world')
			.then(creationResult => {
				expect(creationResult.lambda).toEqual({
					role: 'hello-world-executor',
					region: awsRegion,
					name: 'hello-world'
				});
			})
			.then(() => lambda.getFunctionConfiguration({ FunctionName: 'hello-world' }).promise())
			.then(lambdaResult => expect(lambdaResult.Runtime).toEqual('nodejs6.10'))
			.then(done, done.fail);
		});
		it('renames scoped NPM packages to a sanitized Lambda name', done => {
			config.name = undefined;
			createFromDir('hello-world-scoped')
			.then(creationResult => {
				expect(creationResult.lambda).toEqual({
					role: 'test_hello-world-executor',
					region: awsRegion,
					name: 'test_hello-world'
				});
			})
			.then(() => lambda.getFunctionConfiguration({ FunctionName: 'test_hello-world' }).promise())
			.then(lambdaResult => expect(lambdaResult.Runtime).toEqual('nodejs6.10'))
			.then(done, done.fail);
		});
		it('uses the package.json description field if --description is not provided', done => {
			createFromDir('package-description')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Description).toEqual('This is the package description'))
			.then(done, done.fail);
		});
		it('uses --description as the lambda description even if the package.json description field is provided', done => {
			config.description = 'description from config';
			createFromDir('package-description')
			.then(getLambdaConfiguration)
			.then(lambdaResult => expect(lambdaResult.Description).toEqual('description from config'))
			.then(done, done.fail);
		});
		it('saves the configuration into claudia.json', done => {
			createFromDir('hello-world')
			.then(creationResult => expect(JSON.parse(fs.readFileSync(path.join(workingdir, 'claudia.json'), 'utf8'))).toEqual(creationResult))
			.then(done, done.fail);
		});
		it('saves the configuration into an alternative configuration file if provided', done => {
			config.config = path.join(workingdir, 'lambda.json');
			createFromDir('hello-world')
			.then(creationResult => {
				expect(shell.test('-e', path.join(workingdir, 'claudia.json'))).toBeFalsy();
				expect(JSON.parse(fs.readFileSync(path.join(workingdir, 'lambda.json'), 'utf8'))).toEqual(creationResult);
			})
			.then(done, done.fail);
		});
		it('configures the function in AWS so it can be invoked', done => {
			createFromDir('hello-world')
			.then(() => lambda.invoke({ FunctionName: testRunName }).promise())
			.then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello world"');
			})
			.then(done, done.fail);
		});
		it('configures the function so it will be versioned', done => {
			createFromDir('hello-world')
			.then(() => lambda.listVersionsByFunction({ FunctionName: testRunName }).promise())
			.then(result => {
				expect(result.Versions.length).toEqual(2);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
			})
			.then(done, done.fail);
		});
		it('adds the latest alias', done => {
			config.version = 'great';
			createFromDir('hello-world')
			.then(() => lambda.getAlias({ FunctionName: testRunName, Name: 'latest' }).promise())
			.then(result => expect(result.FunctionVersion).toEqual('$LATEST'))
			.then(done, done.fail);
		});
		it('adds the version alias if supplied', done => {
			config.version = 'great';
			createFromDir('hello-world')
			.then(() => lambda.getAlias({ FunctionName: testRunName, Name: 'great' }).promise())
			.then(result => expect(result.FunctionVersion).toEqual('1'))
			.then(done, done.fail);
		});
		it('uses local dependencies if requested', done => {
			const projectDir =  path.join(__dirname, 'test-projects', 'local-dependencies');
			config['use-local-dependencies'] = true;
			shell.rm('-rf', path.join(projectDir, 'node_modules'));
			shell.mkdir(path.join(projectDir, 'node_modules'));
			shell.cp('-r', path.join(projectDir, 'local_modules', '*'),  path.join(projectDir, 'node_modules'));
			createFromDir('local-dependencies')
			.then(() => lambda.invoke({ FunctionName: testRunName }).promise())
			.then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello local"');
			})
			.then(done, done.fail);
		});
		it('rewires relative local dependencies to reference original location after copy', done => {
			shell.mkdir('-p', workingdir);
			shell.cp('-r', path.join(__dirname, 'test-projects',  'relative-dependencies/*'), workingdir);
			config.source = path.join(workingdir, 'lambda');
			underTest(config)
			.then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				newObjects.restApi = result.api && result.api.id;
				return result;
			})
			.then(() => lambda.invoke({ FunctionName: testRunName }).promise())
			.then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello relative"');
			})
			.then(done, done.fail);
		});
		it('removes optional dependencies after validation if requested', done => {
			config['optional-dependencies'] = false;
			createFromDir('optional-dependencies')
			.then(() => lambda.invoke({ FunctionName: testRunName }).promise())
			.then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('{"endpoint":"https://s3.amazonaws.com/","modules":[".bin","huh"]}');
			})
			.then(done, done.fail);
		});
		it('removes .npmrc from the package', done => {
			createFromDir('ls-dir')
			.then(() => lambda.invoke({ FunctionName: testRunName }).promise())
			.then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(JSON.parse(lambdaResult.Payload).files).not.toContain('.npmrc');
			})
			.then(done, done.fail);
		});
		it('keeps the archive on the disk if --keep is specified', done => {
			config.keep = true;
			createFromDir('hello-world')
			.then(result => {
				expect(result.archive).toBeTruthy();
				expect(shell.test('-e', result.archive));
			})
			.then(done, done.fail);
		});
		it('uses a s3 bucket if provided', done => {
			const s3 = new aws.S3(),
				logger = new ArrayLogger(),
				bucketName = `${testRunName}-bucket`;
			let archivePath;
			config.keep = true;
			config['use-s3-bucket'] = bucketName;
			s3.createBucket({
				Bucket: bucketName
			}).promise()
			.then(() => {
				newObjects.s3bucket = bucketName;
			})
			.then(() => createFromDir('hello-world', logger))
			.then(result => {
				const expectedKey = path.basename(result.archive);
				archivePath = result.archive;
				expect(result.s3key).toEqual(expectedKey);
				return s3.headObject({
					Bucket: bucketName,
					Key: expectedKey
				}).promise();
			})
			.then(fileResult => expect(parseInt(fileResult.ContentLength)).toEqual(fs.statSync(archivePath).size))
			.then(() => expect(logger.getApiCallLogForService('s3', true)).toEqual(['s3.upload']))
			.then(() => lambda.invoke({ FunctionName: testRunName }).promise())
			.then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello world"');
			})
			.then(done, done.fail);
		});
	});
	describe('deploying a proxy api', () => {
		beforeEach(() => {
			config['deploy-proxy-api'] = true;
		});
		it('creates a proxy web API', done => {
			createFromDir('apigw-proxy-echo')
			.then(creationResult => {
				const apiId = creationResult.api && creationResult.api.id;
				expect(apiId).toBeTruthy();
				expect(creationResult.api.url).toEqual(`https://${apiId}.execute-api.${awsRegion}.amazonaws.com/latest`);
				return apiId;
			})
			.then(apiId => apiGatewayPromise.getRestApiPromise({ restApiId: apiId }))
			.then(restApi => expect(restApi.name).toEqual(testRunName))
			.then(done, done.fail);
		});
		it('creates a proxy web API using a handler from a subfolder', done => {
			shell.mkdir('-p', path.join(workingdir, 'subdir'));
			shell.cp('-r', 'spec/test-projects/apigw-proxy-echo/*', workingdir);
			shell.mv(path.join(workingdir, 'main.js'), path.join(workingdir, 'subdir', 'mainfromsub.js'));
			config.handler = 'subdir/mainfromsub.handler';
			shell.cd(workingdir);
			underTest(config)
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'latest?abc=xkcd&dd=yy'))
			.then(contents => JSON.parse(contents.body))
			.then(params => {
				expect(params.queryStringParameters).toEqual({ abc: 'xkcd', dd: 'yy' });
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.path).toEqual('/');
				expect(params.requestContext.stage).toEqual('latest');
			})
			.then(done, done.fail);
		});
		it('saves the api ID without module into claudia.json', done => {
			createFromDir('apigw-proxy-echo')
			.then(creationResult => {
				const savedContents = JSON.parse(fs.readFileSync(path.join(workingdir, 'claudia.json'), 'utf8'));
				expect(savedContents.api).toEqual({ id: creationResult.api.id });
			})
			.then(done, done.fail);
		});
		it('sets up the API to route sub-resource calls to Lambda', done => {
			createFromDir('apigw-proxy-echo')
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'latest/hello/there?abc=xkcd&dd=yy'))
			.then(contents => JSON.parse(contents.body))
			.then(params => {
				expect(params.queryStringParameters).toEqual({ abc: 'xkcd', dd: 'yy' });
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.path).toEqual('/hello/there');
				expect(params.requestContext.stage).toEqual('latest');
			})
			.then(done, done.fail);
		});
		it('sets up the API to route root calls to Lambda', done => {
			createFromDir('apigw-proxy-echo')
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'latest?abc=xkcd&dd=yy'))
			.then(contents => JSON.parse(contents.body))
			.then(params => {
				expect(params.queryStringParameters).toEqual({ abc: 'xkcd', dd: 'yy' });
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.path).toEqual('/');
				expect(params.requestContext.stage).toEqual('latest');
			})
			.then(done, done.fail);
		});

		it('sets up a versioned API with the stage name corresponding to the lambda alias', done => {
			config.version = 'development';
			createFromDir('apigw-proxy-echo')
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'development/hello/there?abc=xkcd&dd=yy'))
			.then(contents => JSON.parse(contents.body))
			.then(params => {
				expect(params.queryStringParameters).toEqual({abc: 'xkcd', dd: 'yy'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.path).toEqual('/hello/there');
				expect(params.requestContext.stage).toEqual('development');
			})
			.then(done, done.fail);
		});
	});
	describe('creating the web api', () => {
		let apiId;
		beforeEach(() => {
			config.handler = undefined;
			config['api-module'] = 'main';
		});
		it('ignores the handler but creates an API if the api-module is provided', done => {
			createFromDir('api-gw-hello-world')
			.then(creationResult => {
				const apiId = creationResult.api && creationResult.api.id;
				expect(apiId).toBeTruthy();
				expect(creationResult.api.module).toEqual('main');
				expect(creationResult.api.url).toEqual(`https://${apiId}.execute-api.${awsRegion}.amazonaws.com/latest`);
				return apiId;
			})
			.then(apiId => apiGatewayPromise.getRestApiPromise({ restApiId: apiId }))
			.then(restApi => expect(restApi.name).toEqual(testRunName))
			.then(done, done.fail);
		});
		it('saves the api name and module only into claudia.json', done => {
			createFromDir('api-gw-hello-world')
			.then(creationResult => {
				const savedContents = JSON.parse(fs.readFileSync(path.join(workingdir, 'claudia.json'), 'utf8'));
				expect(savedContents.api).toEqual({ id: creationResult.api.id, module: creationResult.api.module });
			})
			.then(done, done.fail);
		});
		it('works when the source is a relative path', done => {
			const workingParent = path.dirname(workingdir),
				relativeWorkingDir = './' + path.basename(workingdir);
			shell.cd(workingParent);
			config.source = relativeWorkingDir;
			createFromDir('api-gw-hello-world')
			.then(creationResult => {
				const savedContents = JSON.parse(fs.readFileSync(path.join(workingdir, 'claudia.json'), 'utf8'));
				expect(savedContents.api).toEqual({ id: creationResult.api.id, module: creationResult.api.module });
			})
			.then(done, done.fail);
		});
		it('uses the name from package.json if --name is not provided', done => {
			config.name = undefined;
			createFromDir('api-gw-hello-world')
			.then(creationResult => {
				const apiId = creationResult.api && creationResult.api.id;
				newObjects.restApi = apiId;
				return apiId;
			})
			.then(apiId => apiGatewayPromise.getRestApiPromise({ restApiId: apiId }))
			.then(restApi => expect(restApi.name).toEqual('api-gw-hello-world'))
			.then(done, done.fail);
		});

		it('when no version provided, creates the latest deployment', done => {
			createFromDir('api-gw-hello-world')
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'latest/hello'))
			.then(contents => expect(contents.body).toEqual('"hello world"'))
			.then(done, done.fail);
		});
		it('wires up the api module from a subfolder', done => {
			shell.mkdir('-p', path.join(workingdir, 'subdir'));
			shell.cp('-r', 'spec/test-projects/api-gw-hello-world/*', workingdir);
			shell.mv(path.join(workingdir, 'main.js'), path.join(workingdir, 'subdir', 'mainfromsub.js'));
			config['api-module'] = 'subdir/mainfromsub';
			shell.cd(workingdir);

			underTest(config)
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'latest/hello'))
			.then(contents => expect(contents.body).toEqual('"hello world"'))
			.then(done, done.fail);
		});

		it('when the version is provided, creates the deployment with that name', done => {
			config.version = 'development';
			createFromDir('api-gw-hello-world')
			.then(creationResult => {
				apiId = creationResult.api && creationResult.api.id;
				expect(creationResult.api.url).toEqual(`https://${apiId}.execute-api.${awsRegion}.amazonaws.com/development`);
			})
			.then(() => callApi(apiId, awsRegion, 'development/hello'))
			.then(contents => expect(contents.body).toEqual('"hello world"'))
			.then(done, done.fail);
		});

		it('adds an api config cache if requested', done => {
			config['cache-api-config'] = 'claudiaConfig';
			createFromDir('api-gw-echo')
			.then(creationResult => creationResult.api.id)
			.then(apiId => callApi(apiId, awsRegion, 'latest/echo'))
			.then(contents => JSON.parse(contents.body))
			.then(params => {
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'latest',
					claudiaConfig: 'nWvdJ3sEScZVJeZSDq4LZtDsCZw9dDdmsJbkhnuoZIY='
				});
			})
			.then(done, done.fail);
		});

		it('makes it possible to deploy a custom stage, as long as the lambdaVersion is defined', done => {
			config.version = 'development';
			createFromDir('api-gw-hello-world')
			.then(creationResult => {
				apiId = creationResult.api && creationResult.api.id;
				return apiGatewayPromise.createDeploymentPromise({
					restApiId: apiId,
					stageName: 'fromtest',
					variables: {
						lambdaVersion: 'development'
					}
				});
			})
			.then(() => callApi(apiId, awsRegion, 'fromtest/hello', { retry: 403 }))
			.then(contents => expect(contents.body).toEqual('"hello world"'))
			.then(done, e => {
				console.log(JSON.stringify(e));
				done.fail();
			});
		});
		it('executes post-deploy if provided with the api', done => {
			config.version = 'development';
			config.postcheck = 'option-123';
			config.postresult = 'option-result-post';
			createFromDir('api-gw-postdeploy')
			.then(creationResult => {
				apiId = creationResult.api && creationResult.api.id;
				expect(creationResult.api.deploy).toEqual({
					result: 'option-result-post',
					wasApiCacheUsed: false
				});
			})
			.then(() => callApi(apiId, awsRegion, 'postdeploy/hello', { retry: 403 }))
			.then(contents => {
				expect(JSON.parse(contents.body)).toEqual({
					'postinstallfname': testRunName,
					'postinstallalias': 'development',
					'postinstallapiid': apiId,
					'postinstallregion': awsRegion,
					'hasPromise': 'true',
					'postinstallapiUrl': `https://${apiId}.execute-api.${awsRegion}.amazonaws.com/development`,
					'hasAWS': 'true',
					'postinstalloption': 'option-123',
					'lambdaVersion': 'development'
				});
			})
			.then(done, e => {
				console.log(JSON.stringify(e));
				done.fail();
			});
		});
		it('works with non-reentrant modules', done => {
			global.MARKED = false;
			createFromDir('non-reentrant')
			.then(done, done.fail);
		});
	});
	it('logs call execution', done => {
		const logger = new ArrayLogger();
		config.handler = undefined;
		config['api-module'] = 'main';
		createFromDir('api-gw-hello-world', logger)
		.then(() => {
			expect(logger.getStageLog(true)
			.filter(entry => entry !== 'waiting for IAM role propagation' && entry !== 'rate-limited by AWS, waiting before retry'))
			.toEqual([
				'loading package config',
				'packaging files',
				'validating package',
				'zipping package',
				'initialising IAM role',
				'creating Lambda',
				'creating version alias',
				'creating REST API',
				'saving configuration'
			]);
			expect(logger.getApiCallLogForService('lambda', true)).toEqual([
				'lambda.createFunction',  'lambda.setupRequestListeners', 'lambda.updateAlias', 'lambda.createAlias'
			]);
			expect(logger.getApiCallLogForService('iam', true)).toEqual(['iam.createRole']);
			expect(logger.getApiCallLogForService('sts', true)).toEqual(['sts.getCallerIdentity']);
			expect(logger.getApiCallLogForService('apigateway', true)).toEqual([
				'apigateway.createRestApi',
				'apigateway.setupRequestListeners',
				'apigateway.setAcceptHeader',
				'apigateway.getRestApi',
				'apigateway.getResources',
				'apigateway.createResource',
				'apigateway.putMethod',
				'apigateway.putIntegration',
				'apigateway.putMethodResponse',
				'apigateway.putIntegrationResponse',
				'apigateway.createDeployment'
			]);
		})
		.then(done, done.fail);
	});
	describe('environment variables', () => {
		let standardEnvKeys, logger;
		const nonStandard = function (key) {
			return standardEnvKeys.indexOf(key) < 0;
		};
		beforeEach(() => {
			logger = new ArrayLogger();
			standardEnvKeys = require('./util/standard-env-keys');
		});
		it('does not add any additional environment variables if set-env not provided', done => {
			createFromDir('env-vars')
			.then(() => {
				return lambda.getFunctionConfiguration({
					FunctionName: testRunName
				}).promise();
			})
			.then(configuration => expect(configuration.Environment).toBeUndefined())
			.then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					InvocationType: 'RequestResponse'
				}).promise();
			})
			.then(result => expect(Object.keys(JSON.parse(result.Payload)).sort()).toEqual(standardEnvKeys))
			.then(done, done.fail);
		});
		it('refuses to work when reading environment variables fails', done => {
			config['set-env'] = 'XPATH,YPATH=/var/lib';
			createFromDir('env-vars', logger)
			.then(done.fail, message => {
				expect(message).toEqual('Cannot read variables from set-env, Invalid CSV element XPATH');
				expect(logger.getApiCallLogForService('lambda', true)).toEqual([]);
				expect(logger.getApiCallLogForService('iam', true)).toEqual([]);
			})
			.then(done);
		});
		it('adds env variables specified in a key-value pair', done => {
			config['set-env'] = 'XPATH=/var/www,YPATH=/var/lib';
			createFromDir('env-vars')
			.then(() => {
				return lambda.getFunctionConfiguration({
					FunctionName: testRunName
				}).promise();
			})
			.then(configuration => {
				expect(configuration.Environment).toEqual({
					Variables: {
						'XPATH': '/var/www',
						'YPATH': '/var/lib'
					}
				});
			})
			.then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					InvocationType: 'RequestResponse'
				}).promise();
			})
			.then(result => JSON.parse(result.Payload))
			.then(env => {
				expect(Object.keys(env).filter(nonStandard).sort()).toEqual(['XPATH', 'YPATH']);
				expect(env.XPATH).toEqual('/var/www');
				expect(env.YPATH).toEqual('/var/lib');
			})
			.then(done, done.fail);
		});
		it('adds env variables specified in a JSON file', done => {
			const envpath = path.join(workingdir, 'env.json');
			shell.mkdir('-p', workingdir);
			fs.writeFileSync(envpath, JSON.stringify({'XPATH': '/var/www', 'YPATH': '/var/lib'}), 'utf8');
			config['set-env-from-json'] = envpath;
			createFromDir('env-vars')
			.then(() => {
				return lambda.getFunctionConfiguration({
					FunctionName: testRunName
				}).promise();
			})
			.then(configuration => {
				expect(configuration.Environment).toEqual({
					Variables: {
						'XPATH': '/var/www',
						'YPATH': '/var/lib'
					}
				});
			})
			.then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					InvocationType: 'RequestResponse'
				}).promise();
			})
			.then(result => JSON.parse(result.Payload))
			.then(env => {
				expect(Object.keys(env).filter(nonStandard).sort()).toEqual(['XPATH', 'YPATH']);
				expect(env.XPATH).toEqual('/var/www');
				expect(env.YPATH).toEqual('/var/lib');
			})
			.then(done, done.fail);
		});
		it('tries to set the KMS key ARN', done => {
			// note, creating a KMS key costs $1 each time, so
			// this is just testing that the code tries to set
			// the key instead of actually using it
			config['set-env'] = 'XPATH=/var/www,YPATH=/var/lib';
			config['env-kms-key-arn'] = 'arn:a:b:c:d';
			createFromDir('env-vars')
			.then(done.fail, err => {
				expect(err.code).toEqual('ValidationException');
				expect(err.message).toMatch(/Value 'arn:a:b:c:d' at 'kMSKeyArn' failed to satisfy constraint/);
			})
			.then(done, done.fail);
		});
		it('loads up the environment variables while validating the package to allow any code that expects them to initialize -- fix for https://github.com/claudiajs/claudia/issues/96', done => {
			config['set-env'] = 'TEST_VAR=abc';
			config.handler = undefined;
			config['api-module'] = 'main';
			process.env.TEST_VAR = '';
			createFromDir('throw-if-not-env').then(done, done.fail);
		});
	});
});

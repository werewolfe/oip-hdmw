import bitcoin from 'bitcoinjs-lib'
import bip32 from 'bip32'
import bip32utils from 'bip32-utils'
import coinselect from 'coinselect'

import Address from './Address'
import { isValidPublicAddress } from './util'

const GAP_LIMIT = 20;

module.exports =
class TransactionBuilder {
	constructor(coin, options, account){
		this.coin = coin;
		this.account = account;

		// Addresses we are sending from
		this.from = [];
		// Addresses we want to send to & amounts
		this.to = [];

		this.passedOptions = {};

		this.parseOptions(options);	
	}
	addFrom(addr){
		if (addr instanceof Address){
			if (isValidPublicAddress(addr.getPublicAddress(), this.coin.network)){
				this.from.push(addr)
			}
		} else {
			throw new Error("From Address MUST BE InstanceOf Address")
		}
	}
	addTo(address, amount){
		if (isValidPublicAddress(address, this.coin.network) && !isNaN(amount)){
			var tmpTo = {
				address: address,
				value: amount
			}
			this.to.push(tmpTo)
		}
	}
	parseOptions(options){
		if (!options)
			return

		// Grab the From Addresses, it can be an array or regular.
		if (options.from){
			if (Array.isArray(options.from)){
				for (var addr of options.from){
					this.addFrom(addr)
				}
			} else {
				this.addFrom(options.from)
			}
		}

		// Load who we are sending to
		if (options.to){
			// Check if we are providing an address string and amount seperately
			if (Array.isArray(options.to)){
				for (var payTo of options.to){
					for (var address in payTo){
						this.addTo(address, payTo[address])
					}
				}
			} else {
				for (var address in options.to){
					this.addTo(address, options.to[address])
				}
			}
		}

		this.passedOptions = options;
	}
	getUnspents(){
		var addresses = this.from.map((address) => { return address.getPublicAddress() });

		return this.coin.explorer.getAddressesUtxo(addresses).then((utxos) => {
			return utxos.map((utxo) => {
				return {
					address: utxo.address,
					txId: utxo.txid,
					vout: utxo.vout,
					scriptPubKey: utxo.scriptPubKey,
					value: utxo.satoshis
				}
			})
		})
	}
	buildInputsAndOutputs(){
		return this.discoverChange().then(() => { 
			return this.getUnspents().then((utxos) => {
				var targets = this.to.map((toObj) => {
					return {
						address: toObj.address,
						value: Math.floor(toObj.value * this.coin.satPerCoin)
					}
				})

				var extraBytesLength = 0;
				var extraBytes = this.coin.getExtraBytes(this.passedOptions);

				if (extraBytes)
					extraBytesLength = extraBytes.length

				return coinselect(utxos, targets, Math.ceil(this.coin.feePerByte), extraBytesLength)
			})
		})
	}
	discoverChange(){
		return new Promise((resolve, reject) => {
			if (this.account){
				this.account.discoverChain(1).then(() => {
					resolve()
				})
			} else {
				resolve()
			}
		})
	}
	buildTX(){
		return this.buildInputsAndOutputs().then((selected) => {
			var inputs = selected.inputs;
			var outputs = selected.outputs;
			var fee = selected.fee;

			// inputs and outputs will be undefined if no solution was found
			if (!inputs || !outputs) 
				return

			let txb = new bitcoin.TransactionBuilder(this.coin.network)

			txb.setVersion(this.coin.txVersion)

			inputs.forEach(input => txb.addInput(input.txId, input.vout))
			outputs.forEach(output => {
				// watch out, outputs may have been added that you need to provide
				// an output address/script for
				if (!output.address){
					// Check if we have access to an account to get the change address from
					if (this.account){
						var changeAddress = this.account.getNextChangeAddress().getPublicAddress();
						output.address = changeAddress
					} else {
						console.warning("No Account Provided! Will not send to change address, but rather pay entire change as miners fee!!!")
					}
				}

				txb.addOutput(output.address, output.value)
			})

			for (var i in inputs){
				for (var addr of this.from){
					if (addr.getPublicAddress() === inputs[i].address){
						txb.sign(parseInt(i), addr.getECKey())
					}
				}
			}

			var builtHex = txb.build().toHex();

			var extraBytes = this.coin.getExtraBytes(this.passedOptions)

			if (extraBytes)
				builtHex += extraBytes

			return builtHex
		})
	}
	sendTX(){
		return new Promise((resolve, reject) => {
			this.buildTX().then((hex) => {
				this.coin.explorer.broadcastRawTransaction(hex).then((res) => {
					resolve(res.txid)
				})
			})
		})
	}
}
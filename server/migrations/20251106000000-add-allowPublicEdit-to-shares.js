"use strict";

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("shares", "allowPublicEdit", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },
    async down(queryInterface) {
        await queryInterface.removeColumn("shares", "allowPublicEdit");
    },
};
